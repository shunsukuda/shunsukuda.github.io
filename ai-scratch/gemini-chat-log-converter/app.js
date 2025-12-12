/**
 * Gemini Chat Converter - Main Application
 * 
 * Standalone web app to convert Gemini MHTML/HTML exports to Markdown, JSON, or TOON format.
 * No dependencies, runs entirely in the browser.
 */

// ============================================================================
// DOM Elements
// ============================================================================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const selectBtn = document.getElementById('select-btn');
const fileInfo = document.getElementById('file-info');
const clearBtn = document.getElementById('clear-btn');
const convertBtn = document.getElementById('convert-btn');
const statusEl = document.getElementById('status');
const previewSection = document.getElementById('preview-section');
const previewEl = document.getElementById('preview');
const previewCount = document.getElementById('preview-count');
const copyBtn = document.getElementById('copy-btn');
const formatInputs = document.querySelectorAll('input[name="format"]');
const toonPromptContainer = document.getElementById('toon-prompt-container');
const toonPromptInput = document.getElementById('toon-prompt');

// ============================================================================
// State
// ============================================================================

let selectedFiles = [];
let lastConvertedContent = '';

// ============================================================================
// MHTML Parser
// ============================================================================

/**
 * Parse MHTML file content into parts
 */
function parseMhtml(mhtmlContent) {
    const parts = [];

    // Find the boundary from the first Content-Type header
    // The previous regex was too strict about quotes
    const boundaryMatch = mhtmlContent.match(/boundary=["']?([^"'\s;]+)["']?/i);
    if (!boundaryMatch) {
        // Not MHTML, treat as plain HTML
        console.warn('[Parser] No boundary found, treating as plain HTML');
        return [{
            headers: new Map(),
            content: mhtmlContent,
            contentType: 'text/html',
            location: '',
        }];
    }

    const boundary = boundaryMatch[1];
    console.log('[Parser] Found boundary:', boundary);

    // The MHTML spec says the boundary in the file body is prefixed with "--"
    const boundaryMarker = `--${boundary}`;

    // Split by boundary
    const sections = mhtmlContent.split(boundaryMarker);
    console.log('[Parser] Split into', sections.length, 'sections');

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        // Skip empty sections or the valid ending/starting markers
        if (!section.trim() || section.trim() === '--') continue;

        // Find header/content separator (double newline)
        // CRLF CRLF or LF LF
        const match = section.match(/\r?\n\r?\n/);

        if (!match) {
            console.warn(`[Parser] Section ${i}: No header separator found. Start: ${section.substring(0, 50).replace(/\n/g, '\\n')}`);
            continue;
        }

        const headerEndIndex = match.index;
        const headerSection = section.substring(0, headerEndIndex);
        let content = section.substring(headerEndIndex + match[0].length);

        // Parse headers
        const headers = new Map();
        const headerLines = headerSection.split(/\r?\n/);
        let currentHeader = '';
        let currentValue = '';

        for (const line of headerLines) {
            if (line.trim().length === 0) continue;

            if (line.startsWith(' ') || line.startsWith('\t')) {
                // Continuation line
                currentValue += ' ' + line.trim();
            } else {
                if (currentHeader) {
                    headers.set(currentHeader.toLowerCase(), currentValue);
                }
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    currentHeader = line.substring(0, colonIndex).trim();
                    currentValue = line.substring(colonIndex + 1).trim();
                }
            }
        }
        if (currentHeader) {
            headers.set(currentHeader.toLowerCase(), currentValue);
        }

        const contentType = (headers.get('content-type') || '').toLowerCase();
        const location = headers.get('snapshot-content-location') || headers.get('content-location') || '';
        const encoding = (headers.get('content-transfer-encoding') || '').toLowerCase();

        if (contentType.includes('text/html')) {
            console.log(`[Parser] Section ${i} is HTML.`);
            console.log(`[Parser] Location: ${location}`);
            console.log(`[Parser] Encoding: ${encoding}`);
            console.log(`[Parser] Header End Index: ${headerEndIndex}`);
            console.log(`[Parser] Content Start Raw (50 chars): ${content.substring(0, 50).replace(/\n/g, '\\n')}`);
        }

        // Decode content
        if (encoding === 'base64') {
            try {
                content = atob(content.replace(/\s/g, ''));
                // Note: atob decodes to binary string, might need text decoding if it's text
                if (contentType.includes('text/')) {
                    content = new TextDecoder('utf-8').decode(
                        Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0))
                    );
                }
            } catch (e) {
                console.warn('Failed to decode base64:', e);
            }
        } else if (encoding === 'quoted-printable') {
            content = decodeQuotedPrintable(content);
        }

        if (contentType.includes('text/html')) {
            console.log(`[Parser] Content Decoded Length: ${content.length}`);
            console.log(`[Parser] Content Decoded Start (50 chars): ${content.substring(0, 50).replace(/\n/g, '\\n')}`);
        }

        parts.push({ headers, content, contentType, location });
    }

    return parts;
}

/**
 * Decode quoted-printable encoding (UTF-8 supported)
 */
function decodeQuotedPrintable(str) {
    // Remove soft line breaks (= followed by newline)
    str = str.replace(/=\r?\n/g, '');

    // Create byte array for decoding
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '=' && i + 2 < str.length) {
            const hex = str.slice(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
                continue;
            }
        }
        // If not encoded, push character code (assuming single byte for non-encoded chars in QP)
        bytes.push(char.charCodeAt(0));
    }

    try {
        return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch (e) {
        console.warn('TextDecoder failed, using fallback:', e);
        // Fallback for non-UTF8 or mixed content
        return str.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
}

/**
 * Check if MHTML is from Gemini
 */
function isGeminiMhtml(parts) {
    for (const part of parts) {
        if (part.location.includes('gemini.google.com/app')) {
            return true;
        }
    }
    return false;
}

/**
 * Get Gemini URL from MHTML
 */
function getGeminiUrl(parts) {
    for (const part of parts) {
        if (part.location.includes('gemini.google.com/app')) {
            return part.location;
        }
    }
    return '';
}

/**
 * Find the main HTML part
 * Selects the largest HTML part to avoid selecting iframes or empty parts
 */
function findMainHtmlPart(parts) {
    let bestPart = null;
    let maxLen = -1;

    for (const part of parts) {
        if (part.contentType.includes('text/html')) {
            // Prioritize parts with gemini.google.com if available
            const isGemini = part.location.includes('gemini.google.com');
            const len = part.content.length;

            // Should be reasonably large logic
            // Boost score for gemini url
            const score = len * (isGemini ? 2 : 1);

            if (score > maxLen) {
                maxLen = score;
                bestPart = part;
            }
        }
    }

    if (bestPart) {
        console.log(`[Parser] Selected Main HTML Part. Location: ${bestPart.location}, Length: ${bestPart.content.length}`);
    } else {
        console.warn('[Parser] No HTML part found.');
    }

    return bestPart || parts[0] || null;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract messages from HTML content
 * Uses "Copy" buttons as anchors as requested by user
 */
function extractMessagesFromHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const messages = [];
    const processedNodes = new Set();

    console.log('[Parser] Starting extraction with Copy Button Anchor Strategy');

    // Helper to add message if valid and new
    const addMessage = (role, formattedContent, htmlContent, node) => {
        // Only skip if content is empty (after cleaning) or node already processed
        if (formattedContent.length > 0 && !processedNodes.has(node)) {
            messages.push({ role, content: formattedContent, contentHtml: htmlContent, _node: node });
            processedNodes.add(node);
            return true;
        }
        return false;
    };

    // ---------------------------------------------------------
    // Strategy A: Anchor via "Copy" Buttons (User Requirement)
    // ---------------------------------------------------------

    // 1. Find User Messages via "プロンプトをコピー" button or "content_copy" icon
    // Note: The button might be hidden or icon-only in some views
    const copyButtons = Array.from(doc.querySelectorAll('button'));
    const userCopyButtons = copyButtons.filter(btn => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        const icon = btn.querySelector('mat-icon');
        const iconName = icon ? (icon.getAttribute('data-mat-icon-name') || icon.getAttribute('fonticon') || '') : '';

        // Check for specific label or icon in user query context
        return label === 'プロンプトをコピー' ||
            (iconName === 'content_copy' && btn.closest('user-query'));
    });

    console.log('[Parser] Found', userCopyButtons.length, 'user copy buttons');

    for (const btn of userCopyButtons) {
        // Navigate up to find the container that holds both button and text
        // Structure observed: user-query -> span -> user-query-content -> div.user-query-container
        const container = btn.closest('user-query-content') || btn.closest('user-query');
        if (container) {
            const textEl = container.querySelector('.query-text') || container.querySelector('p');
            if (textEl) {
                addMessage('user', cleanAndFormatContent(textEl.innerHTML), textEl.innerHTML, textEl);
            }
        }
    }

    // 2. Find Agent Responses via "回答をコピー" button
    // Note: This button is often inside a menu or might not be present in MHTML state
    // We look for it, but fallback to model-response tag if missing
    const agentCopyButtons = copyButtons.filter(btn => {
        const label = (btn.getAttribute('aria-label') || '').trim();
        return label === '回答をコピー';
    });

    console.log('[Parser] Found', agentCopyButtons.length, 'agent copy buttons');

    for (const btn of agentCopyButtons) {
        const container = btn.closest('model-response');
        if (container) {
            const textEl = container.querySelector('.response-content') ||
                container.querySelector('.response-container-content');
            if (textEl) {
                addMessage('assistant', cleanAndFormatContent(textEl.innerHTML), textEl.innerHTML, textEl);
            }
        }
    }

    // ---------------------------------------------------------
    // Strategy B: Custom Elements (Fallback & Supplement)
    // ---------------------------------------------------------

    // If we missed messages (e.g. buttons hidden/not captured), use tags
    const userQueries = doc.querySelectorAll('user-query');
    for (const query of userQueries) {
        const textEl = query.querySelector('.query-text');
        if (textEl && !processedNodes.has(textEl)) {
            addMessage('user', cleanAndFormatContent(textEl.innerHTML), textEl.innerHTML, textEl);
        }
    }

    const modelResponses = doc.querySelectorAll('model-response');
    for (const response of modelResponses) {
        const textEl = response.querySelector('.response-container-content') ||
            response.querySelector('.response-content') ||
            response;
        // Avoid adding empty responses (loading states etc)
        // Clean content first to check real length
        const formatted = cleanAndFormatContent(textEl.innerHTML);
        if (formatted.length > 0 && !processedNodes.has(textEl)) {
            addMessage('assistant', formatted, textEl.innerHTML, textEl);
        }
    }

    console.log('[Parser] Total messages extracted:', messages.length);

    if (messages.length === 0) {
        return extractMessagesAlternative(doc);
    }

    // Sort messages by DOM order to ensure conversation flow is correct
    return sortMessagesByDomOrder(messages);
}

/**
 * Sort messages based on their position in the document
 */
function sortMessagesByDomOrder(messages) {
    return messages.sort((a, b) => {
        if (!a._node || !b._node) return 0;

        const position = a._node.compareDocumentPosition(b._node);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
    });
}

/**
 * Clean HTML content and retain structure for Markdown
 * Handles code blocks and removes unwanted "thought process" artifacts
 */
function cleanAndFormatContent(htmlSnippet) {
    // We need a wrapper to parse the snippet properly
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${htmlSnippet}</div>`, 'text/html');
    const root = doc.body.firstChild;

    // 1. Remove unwanted elements (Thinking process, copy buttons, icons)
    const unwantedSelectors = [
        'model-thought',             // The entire thought block if present
        '.thoughts-container',       // Container for thoughts
        '.thoughts-header-button',   // "Show thinking process" button
        'button',                    // Copy buttons etc
        'mat-icon',                  // Icons
        'script',                    // Scripts
        'style',                     // Styles
        'noscript',
        '.export-view-button',       // "Export to Sheets" etc.
        '.export-view-container'     // Container for export buttons
    ];

    unwantedSelectors.forEach(selector => {
        root.querySelectorAll(selector).forEach(el => el.remove());
    });

    // 2. Convert to Markdown-like structure
    // We want to preserve code blocks specifically
    const markdown = convertToMarkdown(root).trim();

    // Cleanup excessive newlines (max 2)
    return markdown.replace(/\n{3,}/g, '\n\n');
}

/**
 * Recursive function to convert DOM node to Markdown
 */
function convertToMarkdown(node, indentLevel = 0) {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }

    const tagName = node.tagName.toLowerCase();

    // Check for code blocks
    if (tagName === 'code-block' || (tagName === 'pre')) {
        let code = '';
        let lang = '';
        // Initialize headerText from attribute (passed from parent loop)
        let headerText = node.getAttribute('data-filename') || '';

        // Try to find header text (filename or language display) inside code-block
        if (tagName === 'code-block') {
            const headerSpan = node.querySelector('.code-block-decoration.header-formatted > span');
            if (headerSpan) {
                const innerHeader = headerSpan.textContent.trim();
                // Determine precedence: External filename vs Internal header
                if (innerHeader) {
                    if (!headerText) {
                        headerText = innerHeader;
                    }
                    // Usually external text (just before block) is better filename than internal language name
                }
            }
        }

        // Try to find code content and language
        // Case 1: <code-block code="..." language="...">
        if (node.hasAttribute('code')) {
            code = node.getAttribute('code');
            lang = node.getAttribute('language') || '';
        }
        // Case 2: <pre><code>...</code></pre>
        else if (node.querySelector('code')) {
            code = node.querySelector('code').textContent;
            // Class often contains "language-python" etc
            const codeClass = node.querySelector('code').className || '';
            const match = codeClass.match(/language-(\w+)/);
            if (match) lang = match[1];
        }
        // Case 3: Just text content of the block
        else {
            // Be careful not to include the header text in the code content if it's in the textContent
            if (tagName === 'code-block' && headerText) {
                // Clone and remove header to get clean code text if it's not in 'code' attribute
                const clone = node.cloneNode(true);
                const header = clone.querySelector('.code-block-decoration');
                if (header) header.remove();
                // Also remove copy buttons
                const buttons = clone.querySelectorAll('button, .buttons');
                buttons.forEach(b => b.remove());
                code = clone.textContent;
            } else {
                code = node.textContent;
            }
        }

        // Fallback: If lang is empty but headerText exists and looks like a language, use it

        // Strict filename check (same as automatic detection below)
        const isSafeFilenameChar = /^[a-zA-Z0-9_\-\./\s`]+$/.test(headerText);
        const hasExtensionOrPath = headerText.includes('.') || headerText.includes('/');
        const isKnownFilename = /^(Dockerfile|Makefile|Gemfile|LICENSE|README|CHANGELOG|COPYING|Cargo\.toml|package\.json|tsconfig\.json)$/i.test(headerText);
        const isStrictFilename = headerText.length > 0 && headerText.length < 200 && isSafeFilenameChar && (hasExtensionOrPath || isKnownFilename);

        if (!lang && headerText) {
            if (isStrictFilename) {
                // It's a filename, don't use as language
            } else {
                // Use as language, cleaning up common garbage like "Ini, TOML" -> "toml"
                if (headerText.includes(',')) {
                    const parts = headerText.split(',').map(s => s.trim());
                    // Prefer the last part as it is often the specific language (e.g. "Ini, TOML" -> TOML)
                    lang = parts[parts.length - 1];
                } else {
                    lang = headerText;
                }
            }
        }

        let fileLabel = '';
        // Only show file label if it passes the STRICT filename check
        if (headerText && isStrictFilename && headerText.toLowerCase() !== lang.toLowerCase()) {
            fileLabel = `**${headerText}**\n`;
        }

        return `\n${fileLabel}\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    // --- Math Support ---
    // Look for KaTeX / MathML structure
    // Typically: <span class="katex"><span class="katex-mathml"><math>...<annotation encoding="application/x-tex">...</annotation>...</math></span>...</span>
    if (node.classList && (node.classList.contains('katex') || node.classList.contains('katex-mathml'))) {
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) {
            return ` $${annotation.textContent}$ `; // Inline math
        }
    }
    // Also check for <gemini-math> or standard <math> tags if used directly
    if (tagName === 'gemini-math' || tagName === 'math') {
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        if (annotation) {
            return ` $$${annotation.textContent}$$ `; // Block math usually? Or inline. gemini-math is often block.
        }
        // Fallback to text content if no annotation found
    }

    // Check for math-inline class (User report)
    if (node.classList && node.classList.contains('math-inline')) {
        return ` $${node.textContent}$ `;
    }
    // Check for math-display class
    if (node.classList && node.classList.contains('math-display')) {
        return `\n$$${node.textContent}$$\n`;
    }

    let content = '';

    // --- Table Support ---
    if (tagName === 'table') {
        // Simple Markdown Table conversion
        const rows = Array.from(node.querySelectorAll('tr'));
        let tableMd = '\n';

        rows.forEach((row, rowIndex) => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            const rowContent = cells.map(cell => {
                // Recursive conversion for cell content, but replace newlines with <br>
                let cellText = convertToMarkdown(cell).trim();
                return cellText.replace(/\n/g, '<br>');
            }).join(' | ');

            tableMd += `| ${rowContent} |\n`;

            // Add separator after header
            if (rowIndex === 0) { // Assuming first row is header
                const separator = cells.map(() => '---').join(' | ');
                tableMd += `| ${separator} |\n`;
            }
        });
        return tableMd + '\n';
    }
    // Skip processing children directly for table related tags as they are handled in 'table' block
    if (['thead', 'tbody', 'tr', 'td', 'th'].includes(tagName)) {
        // If convertToMarkdown is called recursively on them, just process children
        // But since 'table' block handles everything, we shouldn't really hit these unless called independently.
        // For safety, just return children content joined by space or similar? 
        // Actually, if we hit 'tr' outside 'table' logic (unlikely), just process children.
        // BUT, our 'table' logic does not recurse convertToMarkdown(tableNode). It manually processes rows.
        // So we should NOT be here. 
    }

    // Process children with lookahead for filenames
    const childNodes = Array.from(node.childNodes);
    for (let i = 0; i < childNodes.length; i++) {
        const child = childNodes[i];

        // ... (Filename lookahead logic - unchanged) ...
        let next = null;
        for (let j = i + 1; j < childNodes.length; j++) {
            const sibling = childNodes[j];
            if (sibling.nodeType === Node.TEXT_NODE && !sibling.textContent.trim()) continue;
            next = sibling;
            break;
        }

        let potentialFilename = null;
        if (child.nodeType === Node.TEXT_NODE) {
            potentialFilename = child.textContent.trim();
        } else if (child.nodeType === Node.ELEMENT_NODE &&
            ['CODE', 'SPAN', 'STRONG', 'B', 'EM'].includes(child.tagName)) {
            potentialFilename = child.textContent.trim();
        }

        if (potentialFilename && next && next.nodeType === Node.ELEMENT_NODE &&
            (next.tagName === 'CODE-BLOCK' || next.tagName === 'PRE')) {

            const text = potentialFilename;
            // Heuristic for filename: 
            // 1. Not too long (< 200 chars)
            // 2. Contains typical filename chars
            // 3. Must have extension (.) OR path separator (/) to be safe.
            //    OR be exactly specialized filenames like Dockerfile, Makefile, LICENSE...

            const isSafeFilenameChar = /^[a-zA-Z0-9_\-\./\s`]+$/.test(text);
            const hasExtensionOrPath = text.includes('.') || text.includes('/');
            const isKnownFilename = /^(Dockerfile|Makefile|Gemfile|LICENSE|README|CHANGELOG|COPYING|Cargo\.toml|package\.json|tsconfig\.json)$/i.test(text);

            const isFilename = text.length > 0 && text.length < 200 &&
                isSafeFilenameChar &&
                (hasExtensionOrPath || isKnownFilename);

            if (isFilename) {
                next.setAttribute('data-filename', text);
                continue;
            }
        }

        // Control Indentation for Lists
        let nextLevel = indentLevel;
        if (tagName === 'li' && child.nodeType === Node.ELEMENT_NODE &&
            (child.tagName === 'UL' || child.tagName === 'OL')) {
            nextLevel = indentLevel + 1;
        }

        // Pass indentLevel for lists if needed
        content += convertToMarkdown(child, nextLevel);
    }

    // Formatting based on tag
    const indent = '  '.repeat(indentLevel);

    switch (tagName) {
        case 'p':
        case 'div':
            // Only add newlines if content is not empty
            // Also avoid deep nesting of divs causing too many newlines
            return content.trim() ? `\n\n${content}\n\n` : content;
        case 'br':
            return '\n';
        case 'h1': return `\n# ${content}\n`;
        case 'h2': return `\n## ${content}\n`;
        case 'h3': return `\n### ${content}\n`;
        case 'h4': return `\n#### ${content}\n`;
        case 'h5': return `\n##### ${content}\n`;
        case 'h6': return `\n###### ${content}\n`;
        case 'hr': return '\n---\n';

        // --- List Support ---
        case 'ul':
        case 'ol':
            return `\n${content}\n`;
        case 'li':
            // Check parent for ordered/unordered?
            // node.parentElement would be ul or ol
            let prefix = '-';
            if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'ol') {
                prefix = '1.'; // Markdown handles numbering automatically
            }
            // Add indentation
            return `\n${indent}${prefix} ${content.trim()}\n`;

        case 'b':
        case 'strong':
            return `**${content}**`;
        case 'i':
        case 'em':
            return `*${content}*`;
        case 'a':
            return `[${content}](${node.getAttribute('href') || ''})`;
        case 'code':
            return `\`${content}\``;
        default:
            return content;
    }
}


/**
 * Alternative extraction using broader patterns
 */
function extractMessagesAlternative(doc) {
    const messages = [];
    const processedTexts = new Set();
    const main = doc.querySelector('main') || doc.body;
    const divs = main.querySelectorAll('div');

    for (const div of divs) {
        const text = (div.textContent || '').trim();
        if (text.length < 20 || text.length > 50000 || processedTexts.has(text)) continue;

        const className = (div.className || '').toString().toLowerCase();
        const html = div.outerHTML.toLowerCase();

        let role = null;

        if (className.includes('user') || className.includes('query') || className.includes('human') ||
            html.includes('data-user') || html.includes('user-query')) {
            role = 'user';
        } else if (className.includes('model') || className.includes('response') ||
            className.includes('assistant') || className.includes('markdown') ||
            html.includes('data-model') || html.includes('model-response')) {
            role = 'assistant';
        }

        if (role) {
            const isDuplicate = Array.from(processedTexts).some(t => t.includes(text) && t !== text);
            if (!isDuplicate) {
                processedTexts.add(text);
                messages.push({
                    role,
                    content: cleanAndFormatContent(div.innerHTML),
                    contentHtml: div.innerHTML,
                    _node: div
                });
            }
        }
    }

    return sortMessagesByDomOrder(messages);
}

/**
 * Main extraction function
 */
function extractChatFromMhtml(content) {
    const parts = parseMhtml(content);
    console.log('[Parser] Found', parts.length, 'MHTML parts');

    // Check if from Gemini
    if (!isGeminiMhtml(parts)) {
        throw new Error('このファイルは Gemini のチャットログではありません。\nSnapshot-Content-Location が gemini.google.com を含んでいません。');
    }

    const conversationUrl = getGeminiUrl(parts);
    const htmlPart = findMainHtmlPart(parts);

    if (!htmlPart) {
        throw new Error('HTML コンテンツが見つかりません');
    }

    console.log('[Parser] HTML part length:', htmlPart.content.length);

    const messages = extractMessagesFromHtml(htmlPart.content);

    if (messages.length === 0) {
        throw new Error('チャットメッセージを抽出できませんでした。\nファイルの形式を確認してください。');
    }

    // Extract title
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlPart.content, 'text/html');

    // Try to extract from specific element first (User request)
    let title = '';
    const titleEl = doc.querySelector('.conversation-title');
    if (titleEl) {
        title = titleEl.textContent.trim();
        console.log('[Parser] Extracted title from .conversation-title:', title);
    }

    // Fallback to document title
    if (!title) {
        title = doc.title || '';
        title = title.replace(' - Gemini', '').replace(' - Google', '').trim();
        console.log('[Parser] Extracted title from doc.title:', title);
    }

    return {
        metadata: {
            source: 'gemini.google.com',
            exportedAt: new Date().toISOString(),
            conversationUrl,
            title: title || undefined,
        },
        messages,
    };
}

// ============================================================================
// Format Converters
// ============================================================================

/**
 * Convert to Markdown
 */
function toMarkdown(data) {
    const lines = [];

    if (data.metadata.title) {
        lines.push(`# ${data.metadata.title}`);
    } else {
        lines.push('# Gemini Chat Log');
    }

    lines.push('');
    lines.push(`> 📅 Exported: ${toLocalISOString(new Date(data.metadata.exportedAt))}`);
    if (data.metadata.conversationUrl) {
        lines.push(`> 🔗 Source: [gemini.google.com](${data.metadata.conversationUrl})`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of data.messages) {
        const roleLabel = msg.role === 'user' ? '👤 **User**' : '🤖 **Gemini**';
        lines.push(`## ${roleLabel}`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

function toLocalISOString(date) {
    const pad = num => (num < 10 ? '0' : '') + num;
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    // Timezone offset
    const offset = -date.getTimezoneOffset();
    const offsetSign = offset >= 0 ? '+' : '-';
    const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
    const offsetMinutes = pad(Math.abs(offset) % 60);

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

/**
 * Convert to JSON
 */
function toJson(data) {
    const exportData = {
        metadata: data.metadata,
        messages: data.messages.map(m => ({
            role: m.role,
            content: m.content,
        })),
    };
    return JSON.stringify(exportData, null, 2);
}

/**
 * Convert to TOON format (using library)
 */
/**
 * Convert to TOON format (using global library)
 */

// Helper to escape internal quotes and newlines for a quoted string
function escapeForQuotedString(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/\\/g, '\\\\')   // Escape backslashes first
        .replace(/"/g, '\\"')     // Escape double quotes
        .replace(/\n/g, '\\n')    // Escape newlines
        .replace(/\r/g, '\\r')    // Escape carriage returns
        .replace(/\t/g, '\\t');   // Escape tabs
}

async function toToon(data, prompt) {
    if (typeof TOON === 'undefined') {
        throw new Error('TOONライブラリが読み込まれていません。インターネット接続を確認してください。');
    }

    try {
        const taskValue = prompt || "これはGeminiとのチャットログです。内容を要約してください。";
        const titleValue = data.metadata.title || '';

        // Use placeholders to avoid TOON library escaping our quotes
        const TITLE_PLACEHOLDER = '__TOON_TITLE_PLACEHOLDER__';
        const TASK_PLACEHOLDER = '__TOON_TASK_PLACEHOLDER__';

        // Store user content values for post-processing
        const userContentMap = new Map();
        let userContentIndex = 0;

        const exportData = {
            metadata: {
                format: "Data is in TOON format (2-space indent, arrays show length and fields).",
                ...data.metadata,
                title: TITLE_PLACEHOLDER,
                task: TASK_PLACEHOLDER
            },
            messages: data.messages.map(m => {
                if (m.role === 'user') {
                    const placeholder = `__USER_CONTENT_${userContentIndex}__`;
                    userContentMap.set(placeholder, m.content);
                    userContentIndex++;
                    return {
                        role: m.role,
                        content: placeholder
                    };
                }
                return {
                    role: m.role,
                    content: m.content
                };
            })
        };

        let result = TOON.encode(exportData);

        // Post-process: replace placeholders with properly quoted values
        result = result.replace(TITLE_PLACEHOLDER, '"' + escapeForQuotedString(titleValue) + '"');
        result = result.replace(TASK_PLACEHOLDER, '"' + escapeForQuotedString(taskValue) + '"');

        // Replace user content placeholders
        for (const [placeholder, content] of userContentMap) {
            result = result.replace(placeholder, '"' + escapeForQuotedString(content) + '"');
        }

        return result;
    } catch (e) {
        console.error('TOON encoding failed:', e);
        throw new Error('TOON形式への変換に失敗しました: ' + e.message);
    }
}

// ============================================================================
// UI Functions
// ============================================================================

function getSelectedFormat() {
    for (const input of formatInputs) {
        if (input.checked) return input.value;
    }
    return 'markdown';
}

function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

function hideStatus() {
    statusEl.className = 'status hidden';
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateFileUI() {
    if (selectedFiles.length > 0) {
        fileInfo.classList.remove('hidden');
        if (selectedFiles.length === 1) {
            fileInfo.querySelector('.file-name').textContent = selectedFiles[0].name;
            fileInfo.querySelector('.file-size').textContent = formatFileSize(selectedFiles[0].size);
        } else {
            const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
            fileInfo.querySelector('.file-name').textContent = `${selectedFiles.length} 個のファイルを選択中`;
            fileInfo.querySelector('.file-size').textContent = formatFileSize(totalSize);
        }
        dropZone.style.display = 'none';
        convertBtn.disabled = false;
    } else {
        fileInfo.classList.add('hidden');
        dropZone.style.display = 'block';
        convertBtn.disabled = true;
        previewSection.classList.add('hidden');
    }
}

function handleFileSelect(files) {
    const validFiles = [];
    let invalidCount = 0;

    // Convert FileList to Array if needed
    const fileArray = files instanceof FileList ? Array.from(files) : (Array.isArray(files) ? files : [files]);

    for (const file of fileArray) {
        const ext = file.name.toLowerCase().split('.').pop();
        if (['mhtml', 'mht'].includes(ext)) {
            validFiles.push(file);
        } else {
            invalidCount++;
        }
    }

    if (validFiles.length === 0) {
        if (invalidCount > 0) {
            showStatus('MHTML ファイルを選択してください', 'error');
        }
        return;
    }

    if (invalidCount > 0) {
        showStatus(`${invalidCount} 個の無効なファイルが除外されました`, 'warning');
    } else {
        hideStatus();
    }

    selectedFiles = validFiles;
    updateFileUI();
}

function clearFile() {
    selectedFiles = [];
    fileInput.value = '';
    lastConvertedContent = '';
    updateFileUI();
    hideStatus();
}

function setLoading(loading) {
    convertBtn.disabled = loading || selectedFiles.length === 0;
    const btnText = convertBtn.querySelector('.btn-text');
    const btnIcon = convertBtn.querySelector('.btn-icon');

    if (loading) {
        btnIcon.innerHTML = '<span class="loading-spinner"></span>';
        btnText.textContent = '変換中...';
    } else {
        btnIcon.textContent = '🔄';
        btnText.textContent = '変換してダウンロード';
    }
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
}

function showPreview(content, messageCount) {
    previewSection.classList.remove('hidden');
    previewCount.textContent = `${messageCount} メッセージ`;

    // Show truncated preview
    const maxLen = 2000;
    if (content.length > maxLen) {
        previewEl.textContent = content.substring(0, maxLen) + '\n\n... (truncated)';
    } else {
        previewEl.textContent = content;
    }

    lastConvertedContent = content;
}

async function handleConvert() {
    if (selectedFiles.length === 0) return;

    hideStatus();
    setLoading(true);

    try {
        const format = getSelectedFormat();
        const results = [];
        const isBatch = selectedFiles.length > 1;
        const totalFiles = selectedFiles.length;

        const convertFile = async (file, index) => {
            if (isBatch) {
                const btnText = convertBtn.querySelector('.btn-text');
                if (btnText) btnText.textContent = `変換中... (${index + 1}/${totalFiles})`;
            }

            const content = await file.text();
            console.log(`[App] Processing ${file.name}, size: ${content.length}`);

            const chatData = extractChatFromMhtml(content);
            let output, extension, mimeType;

            switch (format) {
                case 'markdown':
                    output = toMarkdown(chatData);
                    extension = 'md';
                    mimeType = 'text/markdown';
                    break;
                case 'json':
                    output = toJson(chatData);
                    extension = 'json';
                    mimeType = 'application/json';
                    break;
                case 'toon':
                    output = await toToon(chatData, toonPromptInput.value);
                    extension = 'toon';
                    mimeType = 'text/plain';
                    break;
            }

            // Generate filename
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const title = (chatData.metadata.title || 'gemini-chat')
                .replace(/[^a-zA-Z0-9-_\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, '_')
                .slice(0, 50);

            // For batch processing, we want cleaner filenames inside the zip (no heavy timestamps if possible, or maybe shorter)
            // But let's stick to consistent naming for now.
            const filename = `${title}_${timestamp}.${extension}`;

            return {
                filename,
                content: output,
                mimeType,
                messageCount: chatData.messages.length
            };
        };

        // Process all files
        for (let i = 0; i < selectedFiles.length; i++) {
            results.push(await convertFile(selectedFiles[i], i));
        }

        if (isBatch) {
            // Batch Download (ZIP)
            if (typeof JSZip === 'undefined') {
                throw new Error('JSZip library not loaded. Check internet connection.');
            }

            const zip = new JSZip();
            const usedFilenames = new Set();
            let totalMessages = 0;

            for (const res of results) {
                let fname = res.filename;
                let counter = 1;
                while (usedFilenames.has(fname)) {
                    const parts = fname.split('.');
                    const ext = parts.pop();
                    const base = parts.join('.');
                    fname = `${base}_${counter}.${ext}`;
                    counter++;
                }
                usedFilenames.add(fname);
                zip.file(fname, res.content);
                totalMessages += res.messageCount;
            }

            const content = await zip.generateAsync({ type: 'blob' });
            const zipFilename = `gemini_chats_bulk_${new Date().toISOString().slice(0, 10)}.zip`;

            downloadBlob(content, zipFilename);
            showStatus(`✓ ${totalFiles} ファイル (${totalMessages} メッセージ) を一括変換しました`, 'success');

        } else {
            // Single Download
            const res = results[0];
            downloadFile(res.content, res.filename, res.mimeType);
            showPreview(res.content, res.messageCount);
            showStatus(`✓ ${res.messageCount} メッセージを変換しました`, 'success');
        }

        setTimeout(hideStatus, 5000);

    } catch (error) {
        showStatus(`✗ ${error.message}`, 'error');
        console.error('[App] Error:', error);
    } finally {
        setLoading(false);
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// Event Listeners
// ============================================================================

fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
        handleFileSelect(e.target.files);
    }
});

selectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
});
dropZone.addEventListener('click', () => fileInput.click());
clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length > 0) {
        handleFileSelect(e.dataTransfer.files);
    }
});

convertBtn.addEventListener('click', handleConvert);

// Toggle TOON Prompt visibility
formatInputs.forEach(input => {
    input.addEventListener('change', () => {
        if (input.value === 'toon') {
            toonPromptContainer.classList.remove('hidden');
        } else {
            toonPromptContainer.classList.add('hidden');
        }
    });
});

copyBtn.addEventListener('click', () => {
    if (lastConvertedContent) {
        navigator.clipboard.writeText(lastConvertedContent).then(() => {
            copyBtn.textContent = '✓ コピーしました';
            setTimeout(() => { copyBtn.textContent = '📋 コピー'; }, 2000);
        });
    }
});

// Initialize
updateFileUI();
// Check initial format state (in case browser preserved selection on reload)
const initialFormat = getSelectedFormat();
if (initialFormat === 'toon') {
    toonPromptContainer.classList.remove('hidden');
}

console.log('[App] Gemini Chat Converter initialized');
