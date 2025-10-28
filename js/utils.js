/**
 * utils.js
 * 包含所有通用的、无状态的辅助函数。
 */

// --- 经度连续性处理函数 (新增) ---

/**
 * 将经度标准化到 [-180, 180] 范围内。
 * @param {number} lon - 原始经度。
 * @returns {number} 标准化后的经度。
 */
export const normalizeLongitude = (lon) => {
    // 健壮的标准化方法：确保结果在 [-180, 180] 之间
    let result = (lon + 180) % 360;
    if (result < 0) result += 360;
    return result - 180;
};

/**
 * 计算两个经度之间的最短距离（考虑到日界线环绕）。
 * @param {number} lon1 - 第一个经度。
 * @param {number} lon2 - 第二个经度（如高/低压中心经度）。
 * @returns {number} 两个经度之间的最短距离（度数）。
 */
export const shortestLongitudeDistance = (lon1, lon2) => {
    let diff = lon1 - lon2;
    // 检查是否跨越日界线（差值大于 180 或小于 -180）
    if (diff > 180) {
        diff -= 360;
    } else if (diff < -180) {
        diff += 360;
    }
    return diff;
};

export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    return distance;
}

// --- 现有函数 ---

export const getCategory = (windKts, isTransitioning = false, isExtratropical = false, isSubtropical = false) => {
    if (isSubtropical) {
        if (windKts < 34) return { name: "副热带低压", shortName: "SD", color: "#76d7c4" };
        return { name: "副热带风暴", shortName: "SS", color: "#48c9b0" };
    }
    if (isExtratropical) return { name: "温带气旋", shortName: "EXT", color: "#8e44ad" };
    if (isTransitioning) return { name: "正在温带转化", shortName: "ET", color: "#efcdeb" };
    if (windKts < 24) return { name: "低压区", shortName: "LPA", color: "#aaaaaa" };
    if (windKts < 34) return { name: "热带低压", shortName: "TD", color: "#6ec1ea" };
    if (windKts < 64) return { name: "热带风暴", shortName: "TS", color: "#4dffff" };
    if (windKts < 83) return { name: "1级飓风", shortName: "Cat 1", color: "#ffffd9" };
    if (windKts < 96) return { name: "2级飓风", shortName: "Cat 2", color: "#ffd98c" };
    if (windKts < 113) return { name: "3级飓风 (强)", shortName: "Cat 3", color: "#ff9e59" };
    if (windKts < 137) return { name: "4级飓风 (强)", shortName: "Cat 4", color: "#ff738a" };
    return { name: "5级飓风 (巨)", shortName: "Cat 5", color: "#8d75e6" };
};

export const knotsToKph = kts => Math.round(kts * 1.852);
export const knotsToMph = kts => Math.round(kts * 1.15078);
export const windToPressure = (windKts, circulationSize = 300) => {
    // 1. 根据风速计算基础气压
    const basePressureCalc = 1013.25 - 11.5 * (windKts ** 1.6) / (48.0) ** 1.6;
    
    // 2. 应用环流大小进行微调
    //    现在 circulationSize 是一个有效的、已定义的参数
    const pressure = basePressureCalc + (basePressureCalc - 1013.25) * (0.002 * circulationSize); 
    
    // 3. 返回最终结果，并设置下限
    return Math.max(640, Math.round(pressure));
};

export const pressureToWind = pressureHpa => {
    // 简化的逆向公式 (不完全准确，仅用于可视化)
    const basePressureCalc = 1013.25 - pressureHpa;
    const windKts = (basePressureCalc * 12.5 * (48.0) ** 1.6 / 1.25) ** (1/1.6);
    return Math.max(0, windKts);
};

export function getPressureAt(lon, lat, pressureSystemsArray) {
    let pressureValue = 1012; // 基础气压
    
    const safeLon = lon; 

    pressureSystemsArray.forEach(cell => {
        // 【核心修改】：使用最短距离函数计算 dx，解决高斯单元的环绕问题
        const dx = shortestLongitudeDistance(safeLon, cell.x); 
        const dy = lat - cell.y;
        
        // 高斯单元距离计算
        const exponent = -( ((dx**2) / (2 * cell.sigmaX**2)) + ((dy**2) / (2 * cell.sigmaY**2)) );
        let pressureOffset = Math.exp(exponent) * cell.strength;
        
        // 三角噪声计算 - 由于 sin/cos 周期性，直接使用 lon 即可
        let noise = 0;
        cell.noiseLayers.forEach(layer => {
            noise += Math.sin((safeLon + layer.offsetX) / layer.freqX) * Math.cos((lat + layer.offsetY) / layer.freqY) * layer.amplitude;
        });

        pressureValue += pressureOffset + noise;
    });
    return pressureValue;
}

export const directionToCompass = deg => {
    const val = Math.floor((deg / 22.5) + 0.5);
    const arr = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return arr[(val % 16)];
};

export function getSST(lat, lon, month, globalTempK = 289) { // [修改] 增加 globalTempK 参数
    
    // [新增] 1. 计算全球温度异常 (基于 16°C / 289K 的基准)
    const BASELINE_TEMP_K = 289.0; // 16°C 基准线
    const tempAnomaly = globalTempK - BASELINE_TEMP_K; // 计算温度距平
    // console.log(tempAnomaly);
    // 2. 季节性SST调整 (保持不变)
    const seasonalModifier = lat > 0 ? 2.7 + Math.cos((month - 8) * (Math.PI / 6)) * 1.9
    : 2.0 - Math.cos((month - 8) * (Math.PI / 6)) * 1.3;
    let baseSST = Math.abs(lat) < 12 ? (32 + 0.6 * tempAnomaly) : Math.max(10, (32 + 0.6 * tempAnomaly) - (Math.abs(lat) - 12) / seasonalModifier + Math.abs(lat / 60) ** 1.6);

    // 3. 洋流调整 (使用高斯衰减函数实现平滑渐变)
    let currentAdjustment = 0;
    
    // --- A. 加利福尼亚寒流 (冷却效应) ---
    const CALI_CENTER_LAT = 30;
    const CALI_CENTER_LON = -125;
    const CALI_MAX_EFFECT = -3.0;
    const CALI_SIGMA_LAT = 15;
    const CALI_SIGMA_LON = 50;
    const dLon_Cali = shortestLongitudeDistance(lon, CALI_CENTER_LON);
    const dLat_Cali = lat - CALI_CENTER_LAT;
    const caliInfluence = Math.exp(
        -( (dLon_Cali**2) / (2 * CALI_SIGMA_LON**2) + (dLat_Cali**2) / (2 * CALI_SIGMA_LAT**2) )
    );
    currentAdjustment += CALI_MAX_EFFECT * caliInfluence;


    // --- B. 北大西洋暖流 (温暖效应) ---
    const GULF_CENTER_LAT = 35;
    const GULF_CENTER_LON = -60;
    const GULF_MAX_EFFECT = 4.0;
    const GULF_SIGMA_LAT = 20;
    const GULF_SIGMA_LON = 25;
    const dLon_Gulf = shortestLongitudeDistance(lon, GULF_CENTER_LON);
    const dLat_Gulf = lat - GULF_CENTER_LAT;
    const gulfInfluence = Math.exp(
        -( (dLon_Gulf**2) / (2 * GULF_SIGMA_LON**2) + (dLat_Gulf**2) / (2 * GULF_SIGMA_LAT**2) )
    );
    currentAdjustment += GULF_MAX_EFFECT * gulfInfluence;

    // --- C. 南海寒流 (弱冷却效应) ---
    const SCS_CENTER_LAT = 20;
    const SCS_CENTER_LON = 115;
    const SCS_MAX_EFFECT = -1.0 - 0.5 * Math.abs(month - 8);
    const SCS_SIGMA_LAT = 12;
    const SCS_SIGMA_LON = 8 + Math.abs(month - 8);
    const dLon_SCS = shortestLongitudeDistance(lon, SCS_CENTER_LON);
    const dLat_SCS = lat - SCS_CENTER_LAT;
    const scsInfluence = Math.exp(
        -( (dLon_SCS**2) / (2 * SCS_SIGMA_LON**2) + (dLat_SCS**2) / (2 * SCS_SIGMA_LAT**2) )
    );
    currentAdjustment += SCS_MAX_EFFECT * scsInfluence;

    // --- D. 加那利寒流 (中等冷却效应) --- (*** 新增代码块开始 ***)
    const CANARY_CENTER_LAT = 30;   // 纬度中心
    const CANARY_CENTER_LON = -20;  // 经度中心 (非洲西北外海)
    const CANARY_MAX_EFFECT = -4.0; // 最大冷却效果 (-3.5°C)
    const CANARY_SIGMA_LAT = 15;    // 纬度影响范围 (南北向较广)
    const CANARY_SIGMA_LON = 40;    // 经度影响范围 (东西向较窄)
    
    const dLon_Canary = shortestLongitudeDistance(lon, CANARY_CENTER_LON);
    const dLat_Canary = lat - CANARY_CENTER_LAT;

    // 高斯函数衰减
    const canaryInfluence = Math.exp(
        -( (dLon_Canary**2) / (2 * CANARY_SIGMA_LON**2) + (dLat_Canary**2) / (2 * CANARY_SIGMA_LAT**2) )
    );
    currentAdjustment += CANARY_MAX_EFFECT * canaryInfluence;

    // --- E. 日本暖流 (中等温暖效应)
    const JAPAN_CENTER_LAT = 27;
    const JAPAN_CENTER_LON = 140;
    const JAPAN_MAX_EFFECT = 1.0; // 最大效果 (+1°C)
    const JAPAN_SIGMA_LAT = 5;    // 纬度影响范围 (南北向较广)
    const JAPAN_SIGMA_LON = 20;    // 经度影响范围 (东西向较窄)
    
    const dLon_JAPAN = shortestLongitudeDistance(lon, JAPAN_CENTER_LON);
    const dLat_JAPAN = lat - JAPAN_CENTER_LAT;

    // 高斯函数衰减
    const JAPANInfluence = Math.exp(
        -( (dLon_JAPAN**2) / (2 * JAPAN_SIGMA_LON**2) + (dLat_JAPAN**2) / (2 * JAPAN_SIGMA_LAT**2) )
    );
    currentAdjustment += JAPAN_MAX_EFFECT * JAPANInfluence;

    // --- F. 墨西哥湾暖区 (强烈温暖效应) ---
    const GOM_CENTER_LAT = 25.0;  // 纬度中心 (墨西哥湾中心)
    const GOM_CENTER_LON = -90.0; // 经度中心 (西经90度)
    const GOM_MAX_EFFECT = 3.0;   // 最大效果 (+3.0°C)，墨西哥湾水温非常高
    const GOM_SIGMA_LAT = 7;      // 纬度影响范围 (南北向)
    const GOM_SIGMA_LON = 10;     // 经度影响范围 (东西向，覆盖大部分海湾)
    
    const dLon_GOM = shortestLongitudeDistance(lon, GOM_CENTER_LON);
    const dLat_GOM = lat - GOM_CENTER_LAT;

    // 高斯函数衰减
    const GOMInfluence = Math.exp(
        -( (dLon_GOM**2) / (2 * GOM_SIGMA_LON**2) + (dLat_GOM**2) / (2 * GOM_SIGMA_LAT**2) )
    );
    currentAdjustment += GOM_MAX_EFFECT * GOMInfluence;

    // --- G. 索马里寒流 (中等冷却效应) ---
    const SOMALIA_CURRENT_CENTER_LAT = 10;  // 纬度中心，接近索马里海岸线
    const SOMALIA_CURRENT_CENTER_LON = 50;  // 经度中心，索马里外海
    const SOMALIA_CURRENT_MAX_EFFECT = -4.5; // 最大冷却效果 (-4.5°C)，索马里寒流比加那利强
    const SOMALIA_CURRENT_SIGMA_LAT = 10;   // 纬度影响范围 (南北向，在赤道附近较窄)
    const SOMALIA_CURRENT_SIGMA_LON = 15;   // 经度影响范围 (东西向)

    const dLon_Somalia = shortestLongitudeDistance(lon, SOMALIA_CURRENT_CENTER_LON);
    const dLat_Somalia = lat - SOMALIA_CURRENT_CENTER_LAT;

    // 高斯函数衰减
    const somaliaInfluence = Math.exp(
        -( (dLon_Somalia**2) / (2 * SOMALIA_CURRENT_SIGMA_LON**2) + (dLat_Somalia**2) / (2 * SOMALIA_CURRENT_SIGMA_LAT**2) )
    );
    currentAdjustment += SOMALIA_CURRENT_MAX_EFFECT * somaliaInfluence;

    // --- H. 本格拉寒流 (Benguela Current) (強烈冷却效應) ---
    const BENGUELA_CURRENT_CENTER_LAT = -25; // 纬度中心，靠近本格拉寒流核心区域（纳米比亚/安哥拉外海）
    const BENGUELA_CURRENT_CENTER_LON = 5;  // 经度中心，靠近非洲西南海岸
    const BENGUELA_CURRENT_MAX_EFFECT = -6.0; // 最大冷却效果 (-6.0°C)，本格拉寒流是重要的上升流寒流
    const BENGUELA_CURRENT_SIGMA_LAT = 15;   // 纬度影响范围 (南北向，影响范围较大)
    const BENGUELA_CURRENT_SIGMA_LON = 25;   // 经度影响范围 (东西向，主要集中在近海)

    const dLon_Benguela = shortestLongitudeDistance(lon, BENGUELA_CURRENT_CENTER_LON);
    const dLat_Benguela = lat - BENGUELA_CURRENT_CENTER_LAT;

    // 高斯函数衰减
    const benguelaInfluence = Math.exp(
        -( (dLon_Benguela**2) / (2 * BENGUELA_CURRENT_SIGMA_LON**2) + (dLat_Benguela**2) / (2 * BENGUELA_CURRENT_SIGMA_LAT**2) )
    );
    currentAdjustment += BENGUELA_CURRENT_MAX_EFFECT * benguelaInfluence;

    // 4. 应用洋流调整
    baseSST += currentAdjustment;

    // 5. 限制返回结果
    return Math.max(0, Math.min(60, baseSST));
}