# Gemini Chat Converter

Gemini のチャットログ（MHTML/HTML）を **Markdown**、**JSON**、**TOON** 形式に変換する Web アプリ。

🔗 **[オンラインで使用する](https://shunsukuda.github.io/ai-scratch/gemini-chat-log-converter)**

---

## 使い方

1. [gemini.google.com](https://gemini.google.com) でチャットを開く
2. **Ctrl + S** → 「ウェブページ、単一ファイル (.mhtml)」で保存
3. このページに MHTML ファイルをドラッグ＆ドロップ
4. エクスポート形式を選択して「変換してダウンロード」

---

## 出力形式

### 📝 Markdown
人間が読みやすい形式。ドキュメントやブログ記事に最適。

### { } JSON
構造化データ形式。プログラムでの処理に最適。

### 🤖 TOON (Token-Oriented Object Notation)
LLM 向けにトークン効率を最適化した新しいフォーマット。
- JSONより30-60%少ないトークン
- YAML風のインデント + CSV風のテーブル構造

---

## ローカルで実行

```bash
# リポジトリをクローン
git clone https://github.com/yourusername/gemini-chat-saver.git
cd gemini-chat-saver

# 簡易サーバーで起動（Python）
python -m http.server 8000

# または（Node.js）
npx serve .
```

ブラウザで http://localhost:8000 を開く

---

## プライバシー

- すべての処理はブラウザ内で完結
- ファイルはサーバーに送信されません
- 外部依存関係なし

---

## ライセンス

MIT
