# 个人多机任务

本人从指定飞书群提交任务，Autoloop 按规则派给电脑上的 Agent。服务器保存资料和成果。一台电脑的接单程序可以同时挂 Codex、Claude Code 和 ZCode，也可以为同一种 Agent 配置不同用途。每轮有独立目录和凭据，服务器确认后清除受管工作区和运行输出。

## 在一台电脑验证

```powershell
node --disable-warning=ExperimentalWarning --test tests/personal-*.test.ts
```

集成用例启动实际中台、两个接单进程，分别模拟 Codex、Claude Code 和 ZCode 的命令参数、凭据和回执。第一台接单机同时运行 Codex 和 Claude Code，第二台运行 ZCode。用例检查原生审核续办、独立的 API 凭据、成果入库和确认后清理。测试只使用本机虚拟资料和凭据。

可以使用官方 v1.8.4 安装目录验证同一组 HTTP 协议：

```powershell
$env:PERSONAL_TEST_HUB='D:\AI学习\agent-autoloop\app'
node --disable-warning=ExperimentalWarning --test tests/personal-integration.test.ts
```

## 配置与运行

1. 在 Linux 用单独数据目录部署官方 Autoloop v1.8.4，只监听回环。给来源 `personal`、每台电脑和本人分别发独立密钥。用 `agent-autoloop key new worker <设备名>` 创建机器身份。把执行机密钥交给该电脑，服务配置里的 `keyHash` 填它的 SHA-256 十六进制摘要。可通过本机 Node 读取受保护的配置文件并计算摘要，避免把密钥放在命令历史中。
2. 将示例复制到各机器的私有目录，替换所有示例值。不启用飞书或统一 API 时，删去对应配置段和未配置的 API 角色。使用 `node examples/recipes/personal-multimachine/main.ts rules <服务配置>` 生成规则，写入新中台的 `rules.json` 后运行 `agent-autoloop check`。两侧的机器名、Agent 产品 `use`、角色编号、模式和指定的 API 模型须一致。
3. 启动中台后运行 `node examples/recipes/personal-multimachine/main.ts server <服务配置>`。服务默认监听 `127.0.0.1:3352`。HTTPS 反向代理仅向执行机公开 `GET /v1/work` 和 `/personal/runs/*`。本人 API、LiteLLM 管理端和数据库只在服务器内访问。示例：

   ```caddy
   workers.example.com {
       @worker path /v1/work /personal/runs/*
       reverse_proxy @worker 127.0.0.1:3352
       respond 404
   }
   models.example.com {
       @inference path /v1/responses /v1/messages /v1/messages/count_tokens /v1/chat/completions /v1/models
       reverse_proxy @inference 127.0.0.1:4000
       respond 404
   }
   ```

4. 每台电脑设置独立的 `AGENT_AUTOLOOP_HOME`，运行 `node examples/recipes/personal-multimachine/main.ts worker <执行机配置>`。为每个角色填写对应 CLI 的绝对路径。也可以指定官方 JS 或 CJS 入口，由 Node 启动。执行机容量默认为 1，每个角色独立排队，多个角色可按整机容量并行。测试用 `allowLoopback: true` 仅允许本机 HTTP。
5. 服务器上为工作台设置 `AUTOLOOP_PERSONAL_CONFIG` 指向服务配置，使用已有工作台启动命令。通过 SSH 转发工作台端口，在“个人任务”看机器、角色、任务和下载。工作台对本人会话代理只读任务和成果入口。

飞书配置使用独立的机器人资料目录。群消息订阅接收指定群内本人明确 @ 机器人的文本，云文档需要授予该应用读取权限。通过正式 Autoloop 的飞书通道处理私聊卡片，群入口与卡片通道使用不同事件键、同一 CLI 配置。群内只回任务编号，成果从本人小镇下载。正式环境启用前先在测试群核对读取权限和私聊回传。

## 数据接口

| 请求 | 作用 |
| --- | --- |
| `POST /personal/tasks` | 本人提交 `{id,text,mode?,node?,agent?,use?,files?,knowledge?}`。id 为稳定提交编号。可用 use 指定 Agent 产品。未指定角色时按配置关键词、机器可用性与稳定顺序分派。 |
| `POST /personal/knowledge` | 本人用 `{files:[{name,data}]}` 导入共享资料。data 是 Base64，返回不可变的版本 ID。提交时可用 knowledge 数组引用版本。 |
| `GET /personal/knowledge` | 本人列出资料版本。 |
| `GET /personal/tasks` | 本人查询机器与任务，任务详情含本轮成果和清理确认。 |
| `/personal/runs/:run/:attempt/*` | 设备密钥和中台该轮令牌共同校验。供接单程序获取资料、领取模型租约、提交结果和报告清理。 |

首版集中使用服务私有目录里的 SQLite，单次输入或输出上限 24 MB、32 份文件。成果先写入服务器，再交中台回执。两处确认后自动删除本轮临时目录。断网会保留待交付目录，恢复后重试。审核续办把上一轮服务器确认的成果放入 `previous/`，由新的一轮读取。

统一 API 需要 LiteLLM 和它要求的数据库。各 Agent 使用网关上与其 API 协议匹配的模型别名。服务按轮签发仅能调用该模型的 35 分钟凭据，执行上限为 30 分钟，额度按配置确定，交付或取消时撤销。供应商密钥和 LiteLLM 管理密钥只留服务器。

## Agent 接入方式

| Agent | 凭据与权限 |
| --- | --- |
| Codex | 可用本机登录或统一 API 的 Responses 接口。启用临时会话和工作区沙箱，关闭工具网络访问。Windows 首次运行需验证提升权限的沙箱可以启动。 |
| Claude Code | 可用本机登录或统一 API 的 Messages 接口。需要支持 `--restricted` 和 `--safe-mode` 的 CLI。限制为文件工具，禁用会话保存。统一 API 模式的配置放在本轮目录。 |
| ZCode | 首版以计划模式做分析，完整答复可作为 Markdown 成果回收。需要支持 `--workflow-mode disabled` 的 CLI，通过统一 API 的 Chat Completions 接口使用临时配置。先在专用隔离虚拟机内运行接单程序，只挂载任务工作区并限制出站网络，再在节点配置中填写 `isolatedHost: true`。该设置记录管理员已准备隔离环境，隔离由虚拟机提供。 |

## 首版边界

分类采用配置中的关键词和明确指定。外部动作可向本人提出确认，正式的发消息、发布、删除、付款和生产操作需要另外接入受限执行器。本机登录由各 CLI 管理，验收时要核对原生程序的缓存与日志。保留任务的范围以服务器记录及测试验证的受管目录为准。

本机模拟覆盖任务回传与受管目录清理。Linux 真机、第二台实体设备、正式飞书群和实际 LiteLLM 还需要联调。当前设备加入使用原生每机密钥，入网码和跨节点故障自动转派待实现。原实训营已登记监听与五角色工作流仍使用原入口；把它们迁到个人多机服务需要另外做跨角色成果交接和实际产物验收。
