## l4conn-scenarios.mjs 的场景（原记在「定稿加速（#702）」）

场景在 `scripts/redesign/l4conn-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `l4conn-refused` | 设置·AI 模型编辑夹具模型后关掉假服务，点「测试连接」：提示「连接失败：base_url 上没有服务在响应……」，不出现 fetch failed 与错误码（`l4conn-refused`） | 设置（中文） | 是 | #702 |
| `l4conn-host-not-found` | 把 base_url 改成解析不到的 `http://nosuchhostzz9/v1`（系统解析器真实报 ENOTFOUND，再照 undici 的形状抛出），点「测试连接」：提示「连接失败：找不到 base_url 里的服务器……」（`l4conn-host-not-found`） | 设置（中文） | 是 | #702 |
| `l4conn-proxy-host-typo` | 设置·网络代理打开「启用代理」，主机地址填解析不到的 `proxy-host-typo` 并保存；夹具模型的 base_url 改成 `https://model-probe.test/v1`（请求先解析代理主机，系统解析器真实报 ENOTFOUND，再照 undici 的形状抛出），点「测试连接」：提示「连接失败：连不上「网络代理」里设置的代理。请检查「主机地址」和「端口」，打开代理软件，或关掉「启用代理」。」（`l4conn-proxy-host-typo`） | 设置（中文） | 是 | #702 |
| `l4conn-proxy-host-typo-en` | 同上，先在外观页切到英文界面：提示「Connection failed: Could not reach the proxy set in Network proxy. Check the Host and Port, start your proxy app, or turn off Use a proxy.」（`l4conn-proxy-host-typo-en`） | 设置（英文） | 是 | #702 |
