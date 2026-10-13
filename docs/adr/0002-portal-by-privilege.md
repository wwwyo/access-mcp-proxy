# ADR 0002: MCPはportalに束ね、権限の強いものだけ分ける

Status: Accepted
Date: 2026-10-13

ローカルMCPは、基本的に1つのMCP Server Portal（`mcp.wwwyo.dev`）に束ねて外部agentへ公開する。shellの実行やfilesystemへの書き込みなど、強い権限を持つMCPだけを別のportalに置く。portalの中では、削除・書き込み系のtoolを無効にして露出を絞る。

外部agentが読む文書やtool応答にはprompt injectionが混入しうる。危険なのは、外部の内容を読むtoolと強い権限のtoolが、1つのagentの会話に同時に揃うことである。portalを分けると、1回のログインで強い権限のMCPまで届くことは防げる。一方、ChatGPTは1つの会話で複数のコネクタを使えるため、portalを分けても、両方を同じ会話で有効にすればこの組み合わせは防げない。そのため、portalの分割は権限の強さで行い、どのコネクタを同じ会話で有効にするかは運用で守る。

## 検討した案

- **MCPごとにportal（Access app）を分ける。** 当初はこれを採用した。ただし、上記のとおりChatGPTの会話内での組み合わせは防げず、portalで束ねる利点（1つのURL、1回のログイン、tool選択とpolicyの一元管理）を失う。不採用。
- **すべてを1つのportalに束ねる。** 最も簡単だが、1回のログインでshell系のtoolまで届き、閲覧系のtoolと常に同じ会話に並ぶ。不採用。

## 結果

- 権限の弱いMCPは`mcp.wwwyo.dev`に追加するだけで公開できる。
- 強い権限のMCPは`<name>-mcp.wwwyo.dev`の別portalにし、閲覧系のMCPと同じ会話で有効にしない。
- portalのhostnameは1段のサブドメインにする。2段にするとUniversal SSLの対象外になる。
