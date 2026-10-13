---
status: accepted
---

# ADR 0002: 公開するMCPごとにAccess appを分ける

Date: 2026-10-13

ローカルMCPを外部agentへ公開する単位（Route）ごとに、Cloudflare Accessのアプリ（AUD）を1つ割り当てる。1つのAccessログインや1つのOAuth grantで、複数のRouteを開けるようにはしない。

外部agentが読む文書やtool応答にはprompt injectionが混入しうる。1回のログインでローカルの全MCPに届く構成にすると、閲覧系のtoolが受け取った指示で、filesystemやshell系のtoolまで操作されうる。Routeごとに認可を分ければ、外部agentに渡す権限をそのRouteの範囲に限定できる。

## 検討した案

- **1つのAccess appで複数Routeをまとめる。** ChatGPTへの登録とログインは1回で済む。ただし、1つのgrantで全Routeに届くため、上記の危険が残る。不採用。
- **1つのAccess appで認証し、Proxy側でRouteごとの認可を持つ。** Access appは1つで済む。ただし、利用者は本人1人なので、Proxyでの認可は全Routeを許すか拒むかの二択になり、grant単位の分離にはならない。不採用。
- **MCP Server PortalsでMCPを集約する。** server単位でAccess policyを設定できるが、portalに1回ログインすれば、policyを通るserverすべてに届く。集約を使う場合も、権限の強いMCPは別のportalに分ける。

## 結果

ChatGPTなどへの登録とOAuthログインは、Routeの数だけ必要になる。この手間は、権限を分けるためのコストとして受け入れる。
