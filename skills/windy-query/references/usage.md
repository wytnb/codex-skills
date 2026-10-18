# 执行与恢复（2.3）

需要Node.js 18或更新版本、现有本地Chrome Windy标签页，以及可调用`mcp__chrome_devtools`的Codex工具环境。浏览器驱动脚本依赖`functions.exec`提供的tools/text/load；不能直接用node执行。计划、汇总、控制器CLI和离线测试只使用Node.js内置模块，无需npm安装。复制skill不会自动配置Chrome连接。

## 统一入口

使用已有本地Chrome Windy页，先确认地图ECMWF。只读取公开页面；不调用隐藏天气接口。新点或角色冲突按 [locations.md](locations.md) 核验；地理缓存不等于天气缓存。

**目的地推荐必须先用 [recommendation.md](recommendation.md) 的完整候选入口生成全部子任务，再逐个推进本控制器；不能自行只提交重点候选。** 本文的request.json适用于生成后的子任务或单独天气查询。`complete`、`missing:0`和本控制器的report.md都仅覆盖已提交范围，正式推荐必须另外通过候选范围校验。

创建request.json，例如：
```json
{"destinationIds":["d06"],"dates":["2026-10-23","2026-10-24"],"hours":[9,12,15],"shards":1,"verifyMode":"fast","displayTimeZone":"Asia/Shanghai","followup":{"hours":[18],"cloudSpan":30,"cloudMax":60}}
```
替换日期，不复用示例预报。默认主时段9/12/15；傍晚有活动可直接把18列入hours。默认补查按每个点、每天的降雨/雪量、云量跨度≥30或最大云量≥60触发18点，阈值和时段可配置；followup:false关闭自动补查。该规则不替代明显变化时的相邻时段细查，也不能保证无触发就无天气变化。

```powershell
node "<skill>/scripts/workflow.cjs" prepare <runDir> request.json
```
runDir是新建的工作区相对目录。prepare保存筛选后的atlas、计划、稳定taskId及配置指纹，输出精简摘要；已有任务用reconcile，不重新prepare。按目的地当地时区转UTC，Windy显示时区另存。按各点实际作业数平衡1–3个分片；同点连续采样。多页先验收，不能默认全部标签页互不干扰。

## 浏览器驱动

在functions.exec中设置：
```js
store('windy-run-config',{
  runDir:'work/windy-query',
  skillDir:'<absolute-skill-path>',
  pageIds:[1], waitMs:0, budgetMs:45000
});
```
将skillDir替换为当前安装目录的绝对路径；可安装在CODEX_HOME/skills/windy-query或用户主目录下的.codex/skills/windy-query。运行数据放在工作区work/下，勿放进skill资源目录或提交到仓库。
pageIds按分片顺序，数量至少等于当前分片数。读取并执行 [run-browser-batch.js](../scripts/run-browser-batch.js)，源码直接在工具内部传递：
```js
const cfg=load('windy-run-config');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const r=await tools.exec_command({
  cmd:'Get-Content -Raw -Encoding UTF8 -LiteralPath '+quote(cfg.skillDir+'/scripts/run-browser-batch.js'),
  max_output_tokens:16000
});
if(r.exit_code!==0)throw new Error('Cannot read driver');
const Fn=Object.getPrototypeOf(async function(){}).constructor;
await new Fn('tools','text','load',r.output)(tools,text,load);
```
首次waitMs:0；运行期间通常每25–50秒观察一次，也可设置waitMs:25000在调用内等待。单次观察预算默认45秒，最大55秒，覆盖工具调用及落盘等待。Promise超时不能取消已经发出的工具调用，后台队列可继续；超时必须先核对原页，不重启任务。

驱动会保存旧的已完成任务断点到archive，拒绝覆盖其他未完成任务；注入源码采用工具内传递，避免Chrome工具不能直接读取本地路径。稳定任务ID与每次启动attemptId分开，functions会话丢失后仍从磁盘游标续读。每页串行；相同动作至少5秒，驱动页面调用也保留间隔。

采样fast合并不同动作的等待，仍检查坐标、模型、菜单、时间戳、显示时间、单位、累计周期、加载、重绘与800ms静默。strict用两次分隔至少5秒的稳定读数。未经小样本验收的页面用strict。页面结构或能力检查变化时暂停适配。

## 断点与异常

state.json保存配置指纹、分片绑定、已存盘游标和事件；exports保存原始增量，先写文件再推进游标。snapshot只返回简短配置身份及游标，并自动接回已经写入但尚未登记的文件；需要启动时才加载单个分片配置。不得手动修改atlas或把其他查询天气文件塞入exports。

- 观察超时：等待原工具最终结果，读取同页status。taskId/指纹匹配就继续观察；切勿因超时刷新、init或另起队列。
- start-intent存在但页面身份不匹配：驱动停止自动启动。确认原调用已经结束且页面确无该任务后，使用release-intent命令，参数为runDir、pageId、配置指纹、具体核验原因。仅允许零游标的启动意图被释放。
- 浏览器丢失：已完成读数留在磁盘，驱动按原任务ID只重建未完成图层/时刻，更新配置指纹，不把全部历史行重新发送到浏览器；未完成时段过期则停止并保留缺口。不要把cancel即时返回当停止完成，须等background.running=false。
- needs_review：局部检查或截图，保留错误证据；修复后最多一次resume/start，仍失败则明确记录缺口。不要让驱动循环修复。受限值、空白、灰图或旧数值都不能填零。
- 每页每12行以及异常/结束时另存localStorage断点；它不能替代磁盘文件。恢复时逻辑ID不变，attemptId更新，completed slots可在过去，unfinished slots仍须通过当前168小时门禁。

## 补查、汇总和计量

所有分片已存盘结束后，驱动自动reconcile：合并合法记录、只排缺失的图层/时刻、计算变化时段补查，并更新summary.json、progress.json和report.md。返回ready表示还有补查，继续驱动；返回complete表示本轮Windy计划完成。超过168小时的部分返回windy_complete_with_later_sources_required，按景区逐日→中长期→附近代理→历史→季节风险补证据，不能把该状态当全部天气已取得。

跨日或长暂停后执行：
```powershell
node "<skill>/scripts/workflow.cjs" reconcile <runDir>
node "<skill>/scripts/workflow.cjs" benchmark <runDir>
```
reconcile按当前客户端时间计算新进入168小时的请求，仅补本任务缺口。保留各计划时间锚点和实际checkedAt；新查询须新runDir，不能沿用旧天气。

汇总拒绝非法日期/缺少时区、读取时超168小时、错任务、错坐标/模型/单位。按点位/UTC时刻/图层保留最新合法值，同时保留不同读取版本；cohorts显示每点每天的读取跨度，默认超过30分钟标needsReview（request.maxCohortSpanMs可调整）。checkedAt不是起报时间；未读到起报信息就标unverified，不能称同一起报。

benchmark区分含暂停的墙钟时间、实际读取跨度、单样本中位数、重叠可能存在的采样耗时总和、重复导出、收据字节数及观察次数。未闭合观察可能是超时/中断，不能证明后台失败。actualBilledTokens为空就不给token降幅。冷启动、缓存复用、恢复测试应分别标benchmarkLabel，不能仅据单点采样声称全流程提升。

页面原url可能仍为地图中心，以经过核验的lat/lon为选点证据；便于打开的链接按实际坐标另行生成并标明定位用途。毫米雨量和厘米雪量分列，不直接互换；0cm不证明0mm，累计3小时不等于下了3小时。0mm或低云量只描述所查时刻，云量不是厚度，不能推出全天晴或能见度。

兼容的手工入口仍有make-plan.cjs和summarize-readings.cjs；后者支持旧原始记录，统一控制器额外强制taskId。备用日期可用read-official-forecast.js读取当前中国天气网8–15日公开DOM，完整日期/星期/连续性不符即拒绝。

验证：
```powershell
node "<skill>/scripts/test-all.cjs"
```
现场测试零/非零雨量、云量、换点及异常恢复；成功仅说明通过本适配器的页面一致性检查。
