# ADR 0001: Managed OAuthとProxyの認証境界

Status: Accepted
Date: 2026-10-13

## 判断

CloudflareにOAuthを任せ、ProxyはAccess assertionを署名検証して固定OpenScreen tokenへ変換する。OAuth BearerをJWTとして扱わない。CloudflaredのAccess validationに加え、ProxyのJWT検証とメールallowlistを必須にする。

Managed OAuthのMCP向け資料はoriginでのJWT検証を要求する。一方、一般のapplication-token資料にはTunnel利用時の例外があり、cloudflaredの`originRequest.access.required`でも検証できる。この違いを「TunnelならJWTは不要」とまとめず、今回の明示的なMCP要件に従う。

Sources: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)。

## 代替とトレードオフ

- cloudflaredだけで検証するとProxyはさらに小さくなる。ただしlocalhostに届く別経路が無認証になり、設定の付け忘れもProxyが検知できない。署名検証の依存1個とJWKS通信を追加してこの境界を守る。
- OAuthサーバーを自作するとmetadataやcallback互換性を制御できる。ただしコード交換・refresh・DCR・PKCE・秘密管理の保守範囲が増える。まずManaged OAuthの実metadataとChatGPTで検証し、失敗原因が確定した場合に再検討する。
- MCP SDKで終端して再生成すると旧式SSEとの変換も可能になる。今回のStreamable HTTP中継ではNode HTTPを使い、本文やイベントのJSON-RPCを解釈しない。旧式endpointイベントの安全なURL変換は別スコープ。
- 全レスポンスを保存してから秘密を除去すると検査が容易だがSSEが成立しない。トークン候補のsuffixだけを保持して除去し、backpressure付きで流す。悪意ある上流による任意符号化へのDLPにはならない。
- セッションの所有者確認を省くと再起動後も上流セッションへ接続できるが、別ユーザーが知ったsession IDで操作できる。同一`sub`への結び付けを採用し、再起動後の再initializeを受け入れる。

## 運用の前提

Access policyを本人に限定し、OpenScreenの固定tokenとローカルOSを信頼する。Access JWTは有効期限までのcredentialなので、盗難JWTのreplayやローカル管理者の侵害をProxyだけで排除することはできない。署名検証はその時点のpolicy変更を問い合わせるintrospectionではない。公開アクセスのpolicy評価とrefreshはAccessが担当する。

セッションはメモリ内で最大1,000件・24時間無操作で破棄。ストリームはクライアント切断かAccess JWT期限で終了し、再接続時に新しいJWTを確認する。未知のセッションや別ユーザーのセッションを転送しない。
