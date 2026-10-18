# 定位与证据

- 点位缓存覆盖本次测试的49个目的地，按 `destinationId`（d01…d49）或 `pointIds` 精确筛选；`d06` 为武夷山。它保存地理证据，绝不保存可沿用的天气。先查看脚本返回的点位名/海拔是否匹配本次行程，不能把公园/湖泊中心自动称为峰顶或岸边。
- 搜索可能返回同名车站、公路、行政区或酒店；检查国家、区域、要素类型、地图与实际游览角色。酒店只有被明确用作附近海岸地标时才可使用，不能冒充海滩本身。无结果不填猜测坐标。新增点保留名称、WGS84经纬度、时区、独立地形海拔、来源和核验日期。
- 高德位置通常为GCJ-02，转WGS84再用于Windy与DEM；[vendor/coordtransform.cjs](../scripts/vendor/coordtransform.cjs) 固定2.1.2，附MIT许可证，转换为近似值。OSM数据注明©OpenStreetMap contributors / ODbL 1.0。
- 缓存地形来自公开OpenTopoData SRTM30m（约30m网格、双线性插值）；它不是精确测量峰高。官方山峰海拔另记 `landmarkElevationM`。海面0可以是有效值，服务空值绝不能当0。高差、地名或地图位置冲突时继续核验，必要时仅报告实际选点。
- Windy详情在近邻点切换及重新导航后出现旧海拔残留。详情坐标变化不是海拔新鲜度证据；详情“来源”可能为meteoblue AI，不是地图ECMWF。停用旧版inspectPoint/freshPointMetadata海拔认定流程。
- 扩展点位优先官方/运营方地图、公开POI或GPS实拍。批量地理编码只作候选发现，须审核角色；遵守服务限流、单线程、缓存，遇限流/封禁停下，不循环重试。不要为一次天气查询强制重新编码全库。
- 控制器分开输出coordinateEvidence、terrainElevationM和roleStatus。旧缓存未显式记载角色时显示review-on-use，只按本次路线检查是否匹配，不强制重新地理编码。新增明确角色核验可保存roleVerification:{status,source,checkedAt,role}；不得仅由地名命中自动补写reviewed。
- 备用预报也要核对完整年月日、星期与连续日期。网页新闻更新、搜索抓取时间或URL带年份不证明预报日期新鲜；拒绝旧日历，保存来源的地理范围。景区名称不证明预报针对峰顶。
