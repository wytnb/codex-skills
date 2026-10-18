# 完整候选范围与正式报告

用于比较旅游目的地。清单由完整候选池分类结果产生，不能从已查天气、拟推荐名单或排名前几名倒推。单独查询某景区天气无需建立候选池。

## 1. 独立候选清单

创建工作区内的 `candidates.json`。保留每个候选固定ID，包括A/B、C/D和用户排除X；ID与点位缓存的destinationId一致。A/B必须给出实际游览点及需要评估的当地日期；山区保留高低游览区域。点位未核实先补地理证据，不能漏掉候选或使用猜测坐标。以下是格式示例，日期、候选与点位须按任务替换：

```json
{
  "version": 1,
  "travelDates": ["2026-10-23", "2026-10-24"],
  "candidates": [
    {"id":"d06", "name":"武夷山", "status":"B", "pointIds":["d06p1"], "dates":["2026-10-23","2026-10-24"]}
  ]
}
```

pointIds只是结构示例，以当前atlas真实ID为准。默认每天当地9/12/15点、rain/clouds两层；`hours`只能增加时段。默认变化时触发18点。可设置 `displayTimeZone`、`verifyMode` 及原控制器的followup参数；关闭补查、提高触发阈值、取消18点或放宽30分钟读取跨度检查，须附 `samplingOverride:{reason,file,sha256,quote}`，保存用户授权原文，不能因工作量自行减采样。

C/D/X需 `exclusion:{reason,file,sha256,quote}`。X保存用户排除指示；C须有违反硬性条件的依据；D保存实际与间接证据均不足的依据，不可用低分、不推荐、缺实时数据替代分类。程序能查文件和引用一致性，事实、角色及季节适用性仍须人工核实，不能伪造证据。

```powershell
node "<skill>/scripts/recommendation.cjs" prepare <scopeDir> candidates.json [atlas.json]
```

scopeDir须新建/空目录。入口先保存完整清单、源文件指纹、地理快照及“候选→点位→当地日期→时段→图层”需求矩阵，再自动建立全部A/B查询任务；不会只建立范围内的日期，超168h也保留为待处理需求。各任务在 `scope.json` 的runs中，按相同日程合并点位。遍历全部runs，用[usage.md](usage.md)的驱动推进各relativeDir，允许调序，不允许漏执行。计划生成被中断可用 `resume-prepare <scopeDir>` 接回未建任务；已有浏览器任务仍按原控制器断点处理。

新增候选、点位、日期或时段时，更新原candidates.json及必要的atlas，再执行：

```powershell
node "<skill>/scripts/recommendation.cjs" sync <scopeDir> [atlas.json]
```

sync保留历史、只补新增需求，不重查原任务；拒绝删除候选、减少已登记的日期/点位/时段、改变采样政策或暗改旧点坐标。合法改列C/D/X保留原ID并附分类证据；重新列A/B时不得通过先排除再加入来缩小原需求。正式输出时再次读取原清单，清单变了但未sync会失败。显式更换旅行任务或授权缩减应另建范围，不能把新子集当原任务已完成。

## 2. 降级证据

超168h按景区逐日→中长期趋势→附近代理→同期气候→季节风险补查；范围内查询受限或失败后才可降级。保存公开页面/工具返回的原始文本或DOM收据，在scopeDir的 `evidence.json` 中关联精确slot，不用一段“季节通常不错”覆盖整批候选。证据引用统一为：

```js
{file: "evidence/source.txt", sha256: "文件内容的64位SHA256", quote: "文件中实际存在、至少12字符的原文"}
```

可用Node crypto对实际文件算SHA256。不得手写虚构收据或把测试数据当实际证据。相同受阻入口可复用同一真实故障证据，但其适用点位、日期、图层须逐项列明，局部故障不能扩展为整批故障。

evidence.json结构：

- `scopeId`：本任务scopeId（建议填，填错拒绝）。
- `attempts`：失败记录数组，每项 `{id,checkedAt,reason,slots,artifact}`。reason为restricted、adapter-failed或source-unavailable；slots为明确的 `{point,time,overlay}` 数组，time须有时区。checkedAt是实际尝试时间，须在本任务内，且所列slot当时在未来168小时内。artifact关联真实失败返回。
- `fallbacks`：每项 `{id,checkedAt,reason,slots,attemptId,source,earlierSources}`。reason只能为beyond-168h或query-failed，后者必须引用覆盖这些slot的attempt。超范围按**检查时**重算；已进入168h的旧降级不再代替Windy查询，不能因拖延到过期而降级。
- `source`：`{level,kind,url,geographicScope,summary,limitations,pointIds,dates,artifact}`。level依次为scenic-daily、trend、nearby、historical、seasonal；前三种kind为forecast，其余kind与level相同。明确代理地理范围、适用点日、趋势及限制，历史/季节资料不能写成指定日期预报。checkedAt也用于声明本次来源核验时间。
- `earlierSources`：选择较低级来源前每一级均需 `{level,outcome:"unavailable",checkedAt,artifact}`。仅写“不可获取”无文件证据不通过。
- `cohortReviews`：每个超读取跨度限制的点日需 `{point,date,reason,artifact}`，记录如何处理不同读取版本及不确定性。

除更高优先级来源已确认不可取外，不反复尝试同一受阻入口。参考文件可以被多个记录引用，降级slot之间不可重叠。证据不足时保留missing，不凭空补零或改分类。

## 3. 完成校验与正式导出

```powershell
node "<skill>/scripts/recommendation.cjs" check <scopeDir> [evidence.json]
node "<skill>/scripts/recommendation.cjs" report <scopeDir> ranking.json output.md [output.json] [evidence.json]
```

check只输出简短计数，细项写入coverage.json；不通过退出码1。只检查不会替代正式入口。report在任何正式文件写入前再次校验：

- 完整清单源文件、需求矩阵与点位身份；所有A/B均在评分表，C/D/X保留且不评分。
- 原始exports中读数所属任务/配置、模型、点位、单位、累计周期、实际读取时的168h边界及本任务读取时间；不信任summary.json里的complete/missing计数。
- 所有主时段和按数据触发的补查时段均有有效读数，或适用且证据完整的降级；独立重算触发条件，不能靠少提交补查任务逃过校验。
- 活跃/启动状态不明的浏览器任务、跨版本读取未审阅、未查或无证据降级都阻止正式输出。

ranking.json为 `{weights,ranked,excluded}`。每行须有清单中相同的id/name/status；A/B行给score（0—100）和完整scores（每项0—10），综合分与weights相符，全体A/B一起按分数降序。C/D/X放excluded，不填score/scores。通用表支持days、feature、transport、fare、total、weather、commute、plan、pro、con、gap/reason；按项目任务补齐这些内容，不把缺字段当已核实。

自定义现有报告排版时调用 `writeOfficialReport(scopeDir, ranking, markdown, outputFile, jsonFile, evidenceFile)`，不得只调用check后另行写文件。它每次导出重新检查，失败不创建/覆盖正式报告；原有旧报告不会被删除，应以本轮coverage状态判断是否可用。新报告带范围ID、修订号和实际/降级/缺口计数。查询子任务的report.md只能作为诊断进度，不能拿它代替正式推荐。

成功表示范围与证据一致性通过，不保证预报准确、网页真实性或人工地理/季节判断正确。测试用合成数据只在隔离临时目录使用。验证命令为 `node "<skill>/scripts/test-all.cjs"`，覆盖54候选仅完成15个、正常全覆盖、无依据降级、移动168h边界、清单变更、补查、失效读数及CLI阻断。
