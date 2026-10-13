# Cloudflare設定とChatGPTへの登録

確認日: 2026-10-13。以下は適用手順であり、このプロジェクトからアカウントの設定は変更していません。

## 互換性の確認結果

ChatGPTはMCPのOAuth discovery、DCRまたは事前登録client、PKCE S256、Bearer送信に対応します。CloudflareのManaged OAuthには対応する認可・登録・refresh機能があり、**DCR経由で仕様上の接続条件を満たせます**。両社がこの組み合わせの動作を保証する記述や、この環境での実接続成功は確認できていません。[OpenAI認証仕様](https://developers.openai.com/plugins/build/auth)、[Cloudflare認可フローの仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/)

Managed OAuthはBetaです。Cloudflare公式のagent向け資料には、PKCE challengeの先頭が`-`/`_`の場合の注意と、issuerにschemeがないメタデータ例があります。これらは実環境の応答と照合してください。ChatGPTのPKCE生成をProxyで修正することはできません。登録・token交換が失敗した場合、認証を外して回避せずCloudflare側の互換性問題として調査します。

CloudflareはOAuthの不透明トークンを処理し、originへAccess JWTを渡します。MCPアプリ向け仕様はoriginでの検証を要求します。このProxyはOAuthサーバーを実装しません。[Managed OAuth仕様](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

## 1. Accessアプリを先に作る

Cloudflare管理下の独自ドメインを使い、Zero Trust → Access controls → Applicationsに`mcp.example.com`用のself-hostedアプリを作ります。ホスト全体を保護し、本人のメールだけをAllowするpolicyとIdPを設定します。Everyone・Bypass・Service Authは使いません。アプリのAUD tagとteam domainをREADMEの設定へ転記します。

同じアカウント内にあるMCP server applicationでもManaged OAuthを有効にできます。このガイドは追加のMCP portalを介さないself-hostedアプリを基本とします。

Advanced settingsでManaged OAuthとDynamic Client Registrationを有効化します。Allowed redirect URIsはChatGPTの接続管理画面に出る**実際のcallback URI**だけを許可します。localhost/loopback clientの許可はこの用途では不要です。

OAuth設定の参考JSON（アプリの全設定を置換するファイルとして使わない）:

```json
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": false,
      "allow_any_on_loopback": false,
      "allowed_uris": ["https://chatgpt.com/connector/oauth/REPLACE_WITH_CALLBACK_ID"]
    },
    "grant": { "access_token_lifetime": "15m", "session_duration": "24h" }
  }
}
```

新規接続ではcallback-ID固有のURI、issuer identificationの条件を満たす場合等にはstable URIが使われます。例を推測で許可する代わりに、ChatGPTが表示する値を転記してください。DCRを使う場合、ChatGPT側でclient secretを自作する必要はありません。[OpenAIのcallback要件](https://developers.openai.com/plugins/build/auth)

## 2. TunnelをProxyへ向ける

ProxyはOpenScreenとcloudflaredと同じマシンで起動します。TunnelのPublished application routeを以下に設定し、独自ホスト名のDNSをTunnelに接続します。

| 設定 | 値 |
| --- | --- |
| Hostname | `mcp.example.com`（自分の独自ドメインに置換） |
| Service | `http://127.0.0.1:47822` |
| HTTP Host Header | `mcp.example.com` |
| Disable Chunked Encoding | `false` |
| Access validation | required、同じteamとAUD tag |

OpenScreenの47821をTunnelへ直接公開しません。未対応ホストは`http_status:404`にします。AccessのdiscoveryとOAuth経路はCloudflare側に任せます。Proxyは`/mcp`以外を404にします。Cloudflareのdiscoveryを手動で認証不要にするBypass policyは追加しません。

リモート管理Tunnelの新規構成例:

```json
{
  "config": {
    "ingress": [
      {
        "hostname": "mcp.example.com",
        "service": "http://127.0.0.1:47822",
        "originRequest": {
          "httpHostHeader": "mcp.example.com",
          "disableChunkedEncoding": false,
          "access": { "required": true, "teamName": "your-team", "audTag": ["your-application-audience-tag"] }
        }
      },
      { "service": "http_status:404" }
    ]
  }
}
```

`access.required`はcloudflaredにJWT検証を要求します。一般のAccess資料はTunnel利用時の例外に触れていますが、Managed OAuthのMCP向け指示とlocalhostへの直接アクセスに備え、Proxyの検証も残します。[Tunnelのorigin設定](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)、[Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)

既存Tunnelを流用する場合は、その全ingress設定を維持して対象routeを追加してください。例の構成をそのまま上書きすると既存サービスが消えます。Tunnel tokenはmise + ageに保管し、cloudflaredには環境変数`TUNNEL_TOKEN`から渡します。`--token <実値>`やtokenを含むservice installコマンドは履歴・プロセス引数への露出を避けてください。

```sh
cloudflared tunnel run
```

`cf`を使って設定を管理する場合、現行版のコマンドを匿名の検索で確認します。

```sh
cf cli search "retrieve update access application managed oauth settings"
cf cli search "retrieve update cloudflare tunnel ingress configuration"
```

確認した版では`cf zero-trust access applications update <app-id> --body ...`、`cf tunnels config get <tunnel-id>`、`cf tunnels config update <tunnel-id> --body ...`があります。更新前に既存値とschemaを確認し、GETした設定を保持して変更します。AccessアプリのPUTは全設定を含める必要があります。`cf`のアカウント選択・認証は既存profileに従い、API tokenはmise + ageで管理します。この手順は管理アカウントへの変更を自動実行しません。

## 3. 公開URLでdiscoveryを検証

未認証の非ブラウザリクエストで確認します。以下は秘密を送信しません。

```sh
curl --silent --show-error --dump-header - --output /dev/null \
  --header 'Accept: application/json, text/event-stream' \
  https://mcp.example.com/mcp
```

成功条件は401と`WWW-Authenticate: Bearer`、その中の`resource_metadata`です。302のブラウザログインやHTMLが返る場合はManaged OAuthの適用先を確認します。ヘッダーのmetadata URLを開き、そこにある`authorization_servers`から認可サーバーのmetadataへ進みます。Cloudflareには独自の`/.well-known/cloudflare-access-protected-resource/`の例もあるので、URLを決め打ちしません。

metadataでDCRの`registration_endpoint`、PKCEの`S256`、認可コード・refresh grant、public clientの`none`を確認します。issuerは絶対HTTPS URLで、protected resource metadataの`authorization_servers`と整合している必要があります。OpenAIの認証仕様に照らして、resource parameterと対象resourceの扱いも確認します。検証用にJWTやOAuth tokenを外部のdecoderサイトへ貼り付けないでください。

この段階が失敗した場合には、Proxyの設定を変えてもOAuth互換性は解消しません。Cloudflare側のmetadataを直すか、別のOAuth認可サーバーを検討してください。

## 4. ChatGPTに登録

利用プラン・管理者ポリシーでcustom MCPが許可されていることを確認します。現在の公式手順はPlugins → Add custom MCP serverです。画面がApps/Createまたはdeveloper modeとして表示される環境では、そのcustom MCP追加画面を使います。[OpenAIの接続手順](https://developers.openai.com/plugins/build/app-quickstart)

1. HTTPSの`https://mcp.example.com/mcp`を入力し、名前をOpenScreen等にします。
2. 認証にOAuthを選びます。DCRを利用し、OpenScreenの固定トークンを入力しません。
3. 表示されたcallback URIをAccessのAllowed redirect URIsへ登録します。UIでcallbackが確定する前にscanが走る場合は、そのURIを許可した後で再試行します。
4. AccessのIdPログインと認可を完了し、tool scanでOpenScreenのtoolsが見えることを確認します。
5. 接続を作成し、新しいチャットから選択します。最初は読み取り操作を試し、その後必要な編集操作を明示的に試します。

接続後はaccess token期限をまたぐrefresh、GETの再接続、Proxy再起動後の再initialize、Allowされていないアカウントの拒否も確認します。ProxyはSSEをJWT期限で閉じるため、ChatGPTがtoken更新後に再接続できることを確かめてください。

## 障害時

| 症状 | 確認すること |
| --- | --- |
| public URLで302/HTML | Managed OAuthとAccessの対象ホスト |
| DCR/callback拒否 | 実際のcallback URI・DCR設定 |
| PKCE/token交換失敗 | S256・metadata・Cloudflareの既知の注意点 |
| originで401 | assertion、issuer/AUD、メール制限、時刻、JWKSへのHTTPS疎通 |
| originで403 | Host header・Origin |
| originで404 | path/query、未知セッション・別ユーザー・再起動 |
| originで413 | リクエスト本文1 MiB上限 |
| originで502 | OpenScreen停止・固定token不一致・redirect・応答圧縮 |

JWTの内容や固定トークンをログへ出して調査しないでください。停止時はcloudflaredとProxyを止め、必要ならAccess policyをBlockにします。トークンの変更後はProxyを再起動します。
