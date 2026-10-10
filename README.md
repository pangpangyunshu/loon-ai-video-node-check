# Loon AI 与视频节点批量检测

支持优先检测**策略组内全部可读取的节点**，递归展开嵌套策略组、去重，并跳过拒绝策略。大组分批执行；取不到成员时，回退到明确的入口节点、备用节点或策略组当前选中的实际节点。不会通过切换策略组来检测。

检测项目：ChatGPT、Claude、Gemini、YouTube、TikTok。选择 `core` 时仅测 ChatGPT、YouTube、TikTok。

## 安装

仓库：[pangpangyunshu/loon-ai-video-node-check](https://github.com/pangpangyunshu/loon-ai-video-node-check)。插件会自动加载本仓库的远程 JS，**不需要另行导入本地脚本**。

| 版本 | 插件直链 | 要求 |
| --- | --- | --- |
| 新版 | [NodeServiceCheck.plugin](https://raw.githubusercontent.com/pangpangyunshu/loon-ai-video-node-check/main/NodeServiceCheck.plugin) | Loon 3.5.1 Build 983 或更新 |
| 兼容版 | [NodeServiceCheck-legacy.plugin](https://raw.githubusercontent.com/pangpangyunshu/loon-ai-video-node-check/main/NodeServiceCheck-legacy.plugin) | 插件参数需要 Build 733+ |

1. 复制上表中适合你的插件直链，在 Loon 的插件管理中通过 URL 添加。
2. 启用插件。新版和兼容版只启用其中一个。
3. 从目标策略组的脚本操作入口运行「AI与视频节点检测」，脚本会自动读取 Loon 传入的 `policyGroup` 并展开成员。
4. 如果从插件管理页面运行，第一次保持「策略组序号」为 `0`，脚本会显示当前所有策略组及序号；把目标序号填入「策略组序号」后再次运行即可。也可以从目标策略组入口运行，跳过这一步。
5. 如果只想检测当前入口节点，将「检测模式」改为 `single`；「备用单节点名称」仅用于入口没有策略组信息时的回退。
6. 查看结果矩阵，展开节点名称看原因。大组按照报告给出的下一批起点修改「起始序号」再运行。

插件参数下拉框不能动态读取 Loon 的策略组列表；因此无上下文入口采用“先显示带序号列表、再填写序号运行”的两步选择方式。脚本不会猜测当前默认代理对应的策略组。

### 本地安装与自行托管

脚本直链：[NodeServiceCheck.js](https://raw.githubusercontent.com/pangpangyunshu/loon-ai-video-node-check/main/NodeServiceCheck.js)。手机需要能够访问 `raw.githubusercontent.com` 才能下载远程插件和脚本。

如需本地运行，将 JS 导入 Loon 并命名为 `NodeServiceCheck.js`，再将插件 `[Script]` 中的完整 JS URL 改成 `NodeServiceCheck.js`。如果当前版本不能直接导入 JS 文件，可以新建同名本地脚本并粘贴全文。

如需 Fork 或自行托管，将插件内的 JS URL 改成你自己的真实 HTTPS 直链，再导入修改后的插件；只 Fork 仓库不会自动改变插件中的脚本地址。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 检测模式 | `auto` | `auto` 按当前上下文选择；`batch` 优先批量；`single` 强制单节点 |
| 策略组序号 | `0` | 无上下文时先运行查看列表，再填序号选择；`0` 使用当前入口的策略组 |
| 备用单节点名称 | 空 | 策略组信息读取失败时使用；单节点模式中也可直接指定节点 |
| 检测项目 | `all` | 五项；`core` 只测三项核心服务 |
| 每批节点数 | `20` | 1–100；不是一次运行无限量节点 |
| 起始序号 | `1` | 展开去重后的节点清单，序号从 1 开始 |
| 节点并发 | `2` | 1–3；全部节点共享最多 4 个并发 HTTP 请求 |
| 单请求超时 | `5000` ms | 1000–10000 ms，慢节点可适当增加 |
| 总检测时限 | `240` s | 30–270 s；插件自身执行时限为 300 s |
| 包含 DIRECT | 关闭 | 批量和单节点模式均需开启此项才能测直连；拒绝策略始终跳过 |

订阅更新、策略组成员变化后，下一批序号可能变化。未展开的子组会在报告中明确提示；不会把它当成单个节点冒充完成。

## 结果含义

| 结果 | 含义 |
| --- | --- |
| 🌐 网页可达 | 识别到正常站点页面，网页访问检测通过；不能保证实际服务完全可用 |
| ✅ 链路通过 | YouTube 测试视频的播放器状态和媒体 CDN HEAD，或 TikTok 一个公开视频的 CDN HEAD 通过；未下载视频 |
| ⛔ 明确受限 | 站点返回明确地区错误、受限跳转或测试视频的地区限制 |
| ⚠️ 部分通过 | 页面/播放器通过，但媒体链路未确认 |
| ❔ 无法确认 | 验证码、风控、限流、超时、登录/同意页、响应结构变化等 |
| ❌ 连接失败 | DNS、TLS 或其他连接错误；不等同于服务本身不支持该地区 |
| ⏳ 未完成 | 尚未开始，或总时限到达时仍在等待；按照下一批起点重测 |

- **AI**：没有登录、API Key 或实际发送对话。ChatGPT、Claude、Gemini 的绿色/蓝色网页信号只验证网页访问；账号资格、聊天功能和 App 单独验证。HTTP 403/429 和 Cloudflare 验证不会被直接当成地区限制。
- **YouTube**：使用公开视频 `jNQXAC9IVRw`（Me at the zoo）检查播放器状态；有可直接使用的 Googlevideo 地址时再发 HEAD 请求。签名地址/登录验证变化时会明确报告未确认。只检测一个视频，不检测 Premium、速度或所有内容版权。
- **TikTok**：检查网页、可读取的地区字段，并在页面提供公开视频地址时发 HEAD。地区字段不是解锁证据。App 还受 SIM、设备区域和账号等因素影响。
- 不使用 MitM，不读节点密码，不保存登录信息，不修改全局模式或策略组选择。每次 HTTP 请求都明确指定单个检测节点。
- 当前代理链/前置代理/DNS配置仍可能影响实际出口；不对 IPv4 和 IPv6 分别出具结论。
- 最后一份报告以 JSON 保存在 Loon 脚本存储 `loon.node-service-check.last`，内容含节点名称、结果及耗时，不含密码和媒体签名 URL。下次运行覆盖这份报告。

## 核验与测试

按照 Loon 官方接口编写：`$environment.params`、`$config.getConfig()`、`$config.getSubPolicies()`、`$config.getSelectedPolicy()`、`$httpClient` 与 Generic `$done({title, content, htmlMessage})`。成员回调兼容新版 JSON 字符串和旧版数组。

本地测试模拟 Loon 的回调和网络响应，验证策略组选择、枚举、回退、超时、并发与页面分类；无法替代你手机上的 Loon 真机和实际代理节点测试。运行：

```powershell
node --check NodeServiceCheck.js
node --test tests/node-service-check.test.cjs
```

官方参考：

- [Loon Script API](https://nsloon.app/docs/Script/script_api)
- [新版 Script 语法](https://nsloon.app/docs/Script/script_v2)
- [旧版 Script 语法](https://nsloon.app/docs/Script/script)
- [插件与参数](https://nsloon.app/docs/Plugin/)
- [官方 Generic HTML 示例](https://github.com/Loon0x00/LoonExampleConfig/blob/master/Script/generic_example.js)
