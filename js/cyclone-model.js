/**
 * cyclone-model.js
 * 负责模拟的核心物理逻辑和状态更新。
 */
import { getSST, getPressureAt, normalizeLongitude } from './utils.js';

// --- 新增：定义主要的地形特征 ---
export const terrainFeatures = [
    { name: "taiwan_mountains", type: "Polygon", coordinates: [[ [120.8, 22.3], [121.0, 24.0], [121.4, 24.5], [121.5, 23.5], [120.8, 22.3] ]], properties: { elevation: 265 } },
    { name: "luzon_cordillera", type: "Polygon", coordinates: [[ [120.6, 15.9], [120.5, 16.5], [121.2, 18.2], [121.8, 18.0], [120.6, 15.9] ]], properties: { elevation: 185 } },
    { name: "tibet_alps", type: "Polygon", coordinates: [[ [75.0, 36.0], [97.4, 29.0], [86.5, 27.7], [79.0, 30.6], [75.0, 36.0] ]], properties: { elevation: 275 } },
    { name: "yungui_alps", type: "Polygon", coordinates: [[ [95.0, 31.6], [104.4, 29.0], [108.5, 21.7], [95.0, 24.6], [95.0, 31.6] ]], properties: { elevation: 205 } },
    { name: "hainan_island", type: "Polygon", coordinates: [[ [111.05, 20.14], [110.87, 19.98], [110.69, 19.40], [110.44, 18.77], [109.94, 18.43], [109.18, 18.35], [108.68, 18.93], [108.82, 19.49], [109.2, 19.99], [109.77, 20.08], [110.33, 20.01], [110.8, 20.07], [111.05, 20.14] ]], properties: { elevation: 0} },
    { name: "jp_h", type: "Polygon", coordinates: [[ [131.60, 34.20], [136.23, 34.91], [140.92, 37.14], [131.60, 34.20] ]], properties: { elevation: 0} },
    { name: "jp_k", type: "Polygon", coordinates: [[ [131.20, 31.55], [130.30, 33.48], [131.09, 33.42], [131.50, 33.52], [131.20, 33.48] ]], properties: { elevation: 0} }
];

function isNearLandSimple(lon, lat, worldFeatures) {
    const threshold = 0.1; // 0.05个经纬度的阈值

    // .some() 会在找到第一个满足条件的元素后立即停止，效率很高
    return worldFeatures.some(feature => {
        const polygons = feature.geometry.type === 'Polygon'
            ? [feature.geometry.coordinates]
            : feature.geometry.coordinates;

        return polygons.some(polygon => 
            polygon.some(ring => 
                ring.some(vertex => {
                    const [vertexLon, vertexLat] = vertex;
                    // 快速的绝对值比较
                    return Math.abs(vertexLon - lon) < threshold && Math.abs(vertexLat - lat) < threshold;
                })
            )
        );
    });
}

// 在文件顶部，地形特征定义之后，添加海域配置对象
const basinConfig = {
    'WPAC': { lon: { min: 100, max: 180 }, lat: { min: 5, max: 25 } },  // 西北太平洋
    'EPAC': { lon: { min: 180, max: 260 }, lat: { min: 5, max: 20 } },  // 东北太平洋 (140W to 80W)
    'NATL': { lon: { min: 260, max: 350 }, lat: { min: 6, max: 32 } },  // 北大西洋 (75W to 10W)
    'NIO':  { lon: { min: 60,  max: 100 }, lat: { min: 5, max: 25 } },   // 北印度洋
    'SHEM':  { lon: { min: 140,  max: 200 }, lat: { min: -20, max: -10 } },   // 南太平洋
    'SIO':  { lon: { min: 30,  max: 140 }, lat: { min: -20, max: -10 } },
    'SATL':  { lon: { min: -50,  max: 15 }, lat: { min: -25, max: -10 } }
};

export function initializeCyclone(world, month, basin = 'WPAC', globalTemp, globalShear) { // 接收 basin 参数
    let lat, lon, isOverLand;

    // 1. 从配置中获取所选海域的经纬度范围
    const selectedBasin = basinConfig[basin] || basinConfig['WPAC']; // 默认为 WPAC
    const lonRange = selectedBasin.lon;
    const latBaseRange = selectedBasin.lat;

    // 2. 根据月份计算季节性纬度偏移
    // 余弦函数使纬度在8月达到最高，2月达到最低
    const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2; // 范围 0 到 1

    // 3. 将季节性偏移应用于基础纬度范围
    // 例如，在冬季，整个生成区域会向南偏移
    const latRangeSpan = latBaseRange.max - latBaseRange.min;
    const hem = latBaseRange.max > 0 ? 1 : -1;
    const seasonalShift = latBaseRange.max > 0 ? (latRangeSpan / 4) * (seasonalFactor - 0.5) :
    (latRangeSpan / 4) * (seasonalFactor - 0.5); // 计算偏移量
    const currentMinLat = latBaseRange.min + seasonalShift + hem*Math.max(0,(globalTemp / 2.89 - 100));
    const currentMaxLat = latBaseRange.max + 4 * seasonalShift + hem*(globalTemp / 2.89 - 100);
    const latSpan = currentMaxLat - currentMinLat;

    // 4. 在指定的海域范围内随机生成一个点，直到该点不在陆地上
    do {
        lat = currentMinLat + Math.random() * latSpan;
        lon = lonRange.min + Math.random() * (lonRange.max - lonRange.min);

        // 检查生成的点是否在任何一个陆地特征内
        isOverLand = world.features.some(feature => d3.geoContains(feature, [lon, lat]));
    } while (isOverLand); // 如果在陆地上，就重新循环生成

    // --- 新增：副热带气旋生成逻辑 ---
    const initialSST = getSST(lat, lon, month, globalTemp);
    let isSubtropical = false;
    let subtropicalTransitionTime = 0;
    console.log(initialSST);
    if (initialSST < 27.5 && Math.random() < 0.75 && (lon > 125 || lon < 20)) {
        isSubtropical = true;
        // 转化时间: 12-36 小时 (4-12个模拟步长)
        const durationSteps = 0 + Math.floor(Math.random() * 25);
        subtropicalTransitionTime = durationSteps * 3;
    }

    let isMonsoonDepression = false;
    let monsoonDepressionEndTime = 0;
    if (Math.random() < (0.7 + globalTemp / 72.25 - 4)) {
        isMonsoonDepression = true;
        const durationSteps = 8 + Math.floor(Math.random() * 60);
        monsoonDepressionEndTime = durationSteps * 3;
    }

    return {
        lat: lat,
        lon: lon,
        intensity: 23 + Math.random() * 2,
        direction: 280,
        speed: 10 + Math.random() * 5,
        age: 0,
        shearEventActive: false,
        shearEventEndTime: 0,
        shearEventMagnitude: 0,
        track: [],
        status: 'active',
        isTransitioning: false,
        isExtratropical: false,
        isSubtropical: isSubtropical,
        subtropicalTransitionTime: subtropicalTransitionTime,
        isMonsoonDepression: false,
        monsoonDepressionEndTime: 0,
        extratropicalStage: 'none',
        extratropicalDevelopmentEndTime: 0,
        extratropicalMaxIntensity: 0,
        upwellingCoolingEffect: 0,
        isERCActive: false,
        ercState: 'none',
        ercEndTime: 0,
        ercMpiReduction: 0,
        ercSizeFactor: 1.0,
        circulationSize: 150 + Math.random() * 350,
        r34: 0, r50: 0, r64: 0,
        ace: 0
    };

}

export function initializePressureSystems(cyclone, month) {
    if (typeof month !== 'number' || !Number.isFinite(month)) month = 8;
    const pressureSystems = [];
    const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2;
    const baseLat = cyclone.lat; // 使用气旋的初始纬度作为参考
    const baseLon = cyclone.lon; // 使用气旋的初始经度作为参考

    // 1. 赤道低气压带 (Equatorial Low-Pressure Belt / ITCZ)
    // 这是一个横跨地图的、带状的弱低压区
    pressureSystems.push({
        x: 140, // 经度中心
        y: 2 + (Math.random() - 0.5) * 5, // 纬度中心，围绕5°N轻微摆动
        baseSigmaX: 300, // 经向（东西）范围，非常大，形成“带状”
        sigmaX: 300,
        sigmaY: 10 + Math.random() * 4, // 纬向（南北）范围，较窄
        strength: -(10 + Math.random() * 3), // 负值表示低压
        baseStrength: -(10 + Math.random() * 3),
        velocityX: (Math.random() - 0.5) * 0.1, // 缓慢移动
        velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.01 + Math.random() * 0.01,
        oscillationAmount: 0.1,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 20, freqY: 15, amplitude: 0.5 },
            { offsetX: 50, offsetY: 30, freqX: 5, freqY: 8, amplitude: 0.2 }
        ]
    });

    // 2. 副热带高压带 (Subtropical High-Pressure Belt)
    // 这是由几个强大的、块状的高压中心组成，是引导气旋路径的关键
    // (A) 西太平洋副热带高压主体 (块状)
    pressureSystems.push({
        x: 150 + (Math.random() - 0.5) * 40, // 位于更东边的海洋上
        y: 29 + (Math.random() - 0.5) * 8 + 12 * seasonalFactor, // 围绕30°N摆动
        baseSigmaX: 35 + Math.random() * 30, // 经向范围，形成“块状”
        sigmaX: 0, // 将由振荡更新
        sigmaY: 10 + Math.random() * 15, // 纬向范围
        strength: 12 + Math.random() * 6, // 正值表示高压，强度较大
        baseStrength: 12 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.9, // 缓慢向西移动
        velocityY: (Math.random() - 0.5) * 0.3,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.02 + Math.random() * 0.01,
        oscillationAmount: 0.2 + Math.random() * 0.5,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 8, freqY: 8, amplitude: 0.5 },
            { offsetX: 20, offsetY: 15, freqX: 2, freqY: 3, amplitude: 0.3 }
        ]
    });
    // (B) 大陆及近海的副高脊 (块状延伸)
    pressureSystems.push({
        x: 115 + (Math.random() - 0.5) * 35, // 位于更西边的大陆边缘
        y: 31 + (Math.random() - 0.5) * 10 + 12 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 30 + Math.random() * 25,
        sigmaX: 0,
        sigmaY: 15 + Math.random() * 15,
        strength: 2 + Math.random() * 16,
        baseStrength: 2 + Math.random() * 16,
        velocityX: (Math.random() - 0.5) * 1.5,
        velocityY: (Math.random() - 0.5) * 1.6,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.3,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.4 }
        ]
    });
    // (B2) 大陆副高脊 (块状延伸)
    pressureSystems.push({
        x: 50 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: 28 + (Math.random() - 0.5) * 10 + 10 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 30 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 10 + Math.random() * 8,
        strength: 10 + Math.random() * 8, // 强度略弱于海洋主体
        baseStrength: 10 + Math.random() * 8,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.4 }
        ]
    });

    // (C) 夏威夷高压 (带状延伸)
    pressureSystems.push({
        x: -140 + (Math.random() - 0.5) * 40, // 位于更西边的大陆边缘
        y: 20 + (Math.random() - 0.5) * 20 + 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 40 + Math.random() * 25,
        sigmaX: 0,
        sigmaY: 13 + Math.random() * 13,
        strength: 20 + Math.random() * 10, // 强度略弱于海洋主体
        baseStrength: 20 + Math.random() * 8,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.005 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: Math.random() * 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: Math.random() * 0.2 }
        ]
    });

    // (D) 亚速尔高压 (带状延伸)
    pressureSystems.push({
        x: -30 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: 30 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 50 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 10 + Math.random() * 10,
        strength: 32 + Math.random() * 6, // 强度略弱于海洋主体
        baseStrength: 32 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.4 }
        ]
    });

    // (E) 极地高压 (带状延伸)
    pressureSystems.push({
        x: -60 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: 72 + (Math.random() - 0.5) * 10, // 纬度略偏南
        baseSigmaX: 250,
        sigmaX: 250,
        sigmaY: 10 + Math.random() * 5,
        strength: 25 + Math.random() * 6, // 强度略弱于海洋主体
        baseStrength: 25 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.4 }
        ]
    });

// (F1) 随机低压 (高空冷涡)
    const numberOfSystems = 2 + Math.floor(Math.random() * 7); // 随机生成 1 到 5 个系统
    for (let i = 0; i < numberOfSystems; i++) {
        pressureSystems.push({
            x: (Math.random() - 0.5) * 60 + baseLon, // 位于气旋经度附近
            y: baseLat > 0 ? Math.max(10, (Math.random() - 0.2) * 20 + baseLat) :
            Math.min(-10, (Math.random() - 0.7) * 20 + baseLat), // 位于气旋纬度附近，但至少在10度以上
            sigmaX: 1 + Math.random() * 4,
            sigmaY: 1 + Math.random() * 5,
            strength: -6 + (Math.random()) * 4, // 强度弱
            velocityX: 0.5 - Math.random() * 1,
            velocityY: (Math.random() - 0.5) * 0.1,
            noiseLayers: [
                { offsetX: 0, offsetY: 0, freqX: 5, freqY: 5, amplitude: 0.1 },
                { offsetX: 0, offsetY: 0, freqX: 1, freqY: 1, amplitude: Math.random() * 0.1 }
            ]
        });
    }

// (F2) 随机系统 - 在10月至3月间有几率生成
    const isWinterSeason = (month >= 10 || month <= 3);

    if (isWinterSeason && Math.random() < 0.85) { // 2% chance per step during the winter season
        pressureSystems.push({
            x: 115  + (Math.random() - 0.5) * 15,
            y: 18  + (Math.random() - 0.5) * 5,
            sigmaX: 2 + Math.random() * 3,
            sigmaY: 10,
            strength: 5 + (Math.random()) * 5,
            velocityX: (Math.random()-0.5) * 0.2,
            velocityY: Math.random() * -1.0,
            // 【新增】噪声层
            noiseLayers: [
                { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.0 },
                { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.0 }
            ]
        });
    }

    // (G) 西南太平洋高压 (块状延伸)
    pressureSystems.push({
        x: 190 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: -28 + (Math.random() - 0.5) * 10 - 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 40 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 5 + Math.random() * 10,
        strength: 20 + Math.random() * 6,
        baseStrength: 20 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.3 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.2 }
        ]
    });

    // (H) 西南印度洋高压 (块状延伸)
    pressureSystems.push({
        x: 70 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: -25 + (Math.random() - 0.5) * 10 - 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 40 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 5 + Math.random() * 10,
        strength: 20 + Math.random() * 6,
        baseStrength: 20 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.3 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.2 }
        ]
    });

    // (I) 极地高压 (块状延伸)
    pressureSystems.push({
        x: -60 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: -65 + (Math.random() - 0.5) * 10, // 纬度略偏南
        baseSigmaX: 250,
        sigmaX: 250,
        sigmaY: 10 + Math.random() * 5,
        strength: 25 + Math.random() * 6, // 强度略弱于海洋主体
        baseStrength: 25 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.6 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.4 }
        ]
    });

    // (J) 澳洲低压 (块状延伸)
    pressureSystems.push({
        x: 150 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: -12 + (Math.random() - 0.5) * 10 - 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 30 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 5 + Math.random() * 5,
        strength: -10 + Math.random() * 6,
        baseStrength: 20 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.3 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.2 }
        ]
    });

    // (K) 南大西洋高压 (块状延伸)
    pressureSystems.push({
        x: -30 + (Math.random() - 0.5) * 15, // 位于更西边的大陆边缘
        y: -25 + (Math.random() - 0.5) * 10 - 6 * seasonalFactor, // 纬度略偏南
        baseSigmaX: 30 + Math.random() * 10,
        sigmaX: 0,
        sigmaY: 5 + Math.random() * 10,
        strength: 20 + Math.random() * 6,
        baseStrength: 20 + Math.random() * 6,
        velocityX: (Math.random() - 0.5) * 0.5,
        velocityY: (Math.random() - 0.5) * 0.4,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.025 + Math.random() * 0.01,
        oscillationAmount: 0.25 + Math.random() * 0.2,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 12, freqY: 12, amplitude: 0.3 },
            { offsetX: 10, offsetY: 5, freqX: 3, freqY: 5, amplitude: 0.2 }
        ]
    });

    // 3. 副极地低气压带 (Subpolar Low-Pressure Belt)
    // 位于高纬度的带状低压区，例如阿留申低压
    const subtropicalHighs = pressureSystems.filter(
        p => p.strength > 0 && p.y > 10 && p.y < 45
    );
    const meanSubtropicalLat = subtropicalHighs.length > 0
        ? subtropicalHighs.reduce((sum, p) => sum + p.y, 0) / subtropicalHighs.length
        : 45; // 默认30°N

    const subpolarLat = meanSubtropicalLat + 20 + (Math.random() - 0.5) * 4;

    pressureSystems.push({
        x: 150, // 经度中心
        y: subpolarLat, // 纬度中心，围绕60°N
        baseSigmaX: 250, // 经向范围大，形成“带状”
        sigmaX: 250,
        sigmaY: 8 + Math.random() * 5, // 纬向范围比赤道低压带宽
        strength: -(45 + Math.random() * 10), // 强度较大的低压
        baseStrength: -(45 + Math.random() * 10),
        velocityX: (Math.random() - 0.5) * 0.2,
        velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.015 + Math.random() * 0.01,
        oscillationAmount: 0.15,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 15, freqY: 20, amplitude: 0.8 },
            { offsetX: 30, offsetY: 10, freqX: 6, freqY: 9, amplitude: 0.4 }
        ]
    });

    // 4. 副极地低气压带 (Subpolar Low-Pressure Belt)
    const subtropicalHighsS = pressureSystems.filter(
        p => p.strength > 0 && p.y < -10 && p.y > -40
    );
    const meanSubtropicalLatS = subtropicalHighsS.length > 0
        ? subtropicalHighsS.reduce((sum, p) => sum + p.y, 0) / subtropicalHighsS.length
        : -40; // 默认45°S

    const subpolarLatS = meanSubtropicalLatS - 15 - (Math.random() - 0.5) * 4;

    pressureSystems.push({
        x: 150, // 经度中心
        y: -35 - Math.random() * 5, // 纬度中心，围绕60°N
        baseSigmaX: 250, // 经向范围大，形成“带状”
        sigmaX: 250,
        sigmaY: 5 + Math.random() * 5, // 纬向范围比赤道低压带宽
        strength: -(35 + Math.random() * 10), // 强度较大的低压
        baseStrength: -(35 + Math.random() * 10),
        velocityX: (Math.random() - 0.5) * 0.2,
        velocityY: (Math.random() - 0.5) * 0.1,
        oscillationPhase: Math.random() * Math.PI * 2,
        oscillationSpeed: 0.015 + Math.random() * 0.01,
        oscillationAmount: 0.15,
        // 【新增】噪声层
        noiseLayers: [
            { offsetX: 0, offsetY: 0, freqX: 15, freqY: 20, amplitude: 0.8 },
            { offsetX: 30, offsetY: 10, freqX: 6, freqY: 9, amplitude: 0.4 }
        ]
    });

    updatePressureSystems(pressureSystems); // 应用初始振荡和位置
    return pressureSystems;
}


export function updatePressureSystems(systems) {
     systems.forEach(cell => {
        cell.x += cell.velocityX * 0.3;
        cell.y += cell.velocityY * 0.1;
        cell.oscillationPhase += cell.oscillationSpeed;
        const stretch = Math.sin(cell.oscillationPhase) * cell.oscillationAmount;
       // 确保 baseSigmaX 存在
        if (cell.baseSigmaX) {
            cell.sigmaX = cell.baseSigmaX * (1 + stretch);
        }
    });
    return systems;
}

export function updateFrontalZone(pressureSystems, month) {
    const highPressureCenters = pressureSystems.filter(p => p.strength > 0 && p.y > 0);
    if (highPressureCenters.length === 0) return { latitude: 40 };
    const avgLat = highPressureCenters.reduce((sum, p) => sum + p.y, 0) / highPressureCenters.length;
    return { latitude: avgLat - 3 * Math.abs(month - 8) - 3 * Math.random() };
}

export function calculateSteering(lon, lat, pressureSystemsArray, bias = { u: 0, v: 0 }) {
    const RE = 6371000.0, OMEGA = 7.292115e-5, RHO = 1.225, MIN_F = 1e-5;
    const dDeg = 0.5, maxSteerSpeed = 25 + Math.abs(lat) * 0.5;

    // --- 新增：全局引导气流强度缩放因子 ---
    // 您可以通过调整此值来改变气旋的平均移动速度。
    // 1.0 = 原始物理计算值；< 1.0 = 较慢；> 1.0 = 较快
    const steeringStrengthFactor = lat > 0 ? 0.36 : -0.36;

    const latRad = lat * (Math.PI / 180);

    const MAX_BETA_V = 5; // 在较高纬度的最大向极(北)漂移分量
    const MAX_BETA_U = -0.5; // 在较高纬度的最大向西漂移分量
    const betaFactor = Math.sin(latRad < 0 ? latRad - (Math.PI / 12) : latRad + (Math.PI / 12)); // 使用纬度正弦值作为因子，在赤道为0，向两极增强

    const betaDriftV = MAX_BETA_V * betaFactor + 1 * (Math.random() - 0.5);
    const betaDriftU = MAX_BETA_U * betaFactor + 1 * (Math.random() - 0.5);

    const dx_m = dDeg * (Math.PI / 180) * RE * Math.cos(latRad);
    const dy_m = dDeg * (Math.PI / 180) * RE;

    const p_x_plus = getPressureAt(lon + dDeg, lat, pressureSystemsArray) * 100.0;
    const p_x_minus = getPressureAt(lon - dDeg, lat, pressureSystemsArray) * 100.0;
    const p_y_plus = getPressureAt(lon, lat + dDeg, pressureSystemsArray) * 100.0;
    const p_y_minus = getPressureAt(lon, lat - dDeg, pressureSystemsArray) * 100.0;

    const gradX = (p_x_plus - p_x_minus) / (2.0 * dx_m);
    const gradY = (p_y_plus - p_y_minus) / (2.0 * dy_m);

    let f = 2 * OMEGA * (0.55 * Math.cos(1.5 * latRad * (Math.PI / 180)));
    if (Math.abs(f) < MIN_F) f = (f >= 0 ? MIN_F : -MIN_F);

    let u_geo = -gradY / (RHO * f);
    let v_geo = gradX / (RHO * f);

    // 应用缩放因子
    u_geo *= steeringStrengthFactor;
    v_geo *= steeringStrengthFactor;

    let steerU = u_geo + betaDriftU + bias.u;
    let steerV = v_geo + betaDriftV + bias.v;
    
    // 修正：使用正确的、未缩放的速度进行clamp
    const speed = Math.hypot(steerU, steerV);
    if (speed > maxSteerSpeed) {
        const clampRatio = maxSteerSpeed / speed;
        steerU *= clampRatio;
        steerV *= clampRatio;
    }
    return { steerU, steerV };
}

function updateWindRadii(tc) {
    const rmw = tc.intensity * (0.75 + Math.random());
    const target_r34 = tc.intensity > 34 ? tc.circulationSize * ((tc.intensity - 24) / (rmw * 0.6)) : 0;
    const r50_ratio = ((tc.intensity - 50) / rmw); 
    const target_r50 = target_r34 * r50_ratio;
    const r64_ratio = ((tc.intensity - 64) / rmw);
    const target_r64 = target_r34 * r64_ratio;

    const transitionRate = 0.1;
    tc.r34 += (target_r34 - tc.r34) * transitionRate;
    tc.r50 += ((target_r50 - tc.r50) * transitionRate);
    tc.r64 += ((target_r64 - tc.r64) * transitionRate);
    return tc;
}

export function updateCycloneState(cyclone, pressureSystems, frontalZone, world, month, globalTemp, globalShear) {
    let updatedCyclone = { ...cyclone };
    updatedCyclone.age += 3;

    // ACE Calculation: Sum of squared wind speeds (in knots) for TS or higher systems, every 6 hours.
    // Our simulation step is 3 hours, so we calculate this every other step.
    if (updatedCyclone.age % 6 === 0 && updatedCyclone.intensity >= 34 && !updatedCyclone.isExtratropical) {
        // ACE is scaled by 10^-4
        const ace_contribution = (updatedCyclone.intensity ** 2) / 10000;
        updatedCyclone.ace += ace_contribution;
    }

    if (updatedCyclone.isMonsoonDepression && updatedCyclone.age >= updatedCyclone.monsoonDepressionEndTime) {
        updatedCyclone.isMonsoonDepression = false;
    }

    const { steerU, steerV } = calculateSteering(updatedCyclone.lon, updatedCyclone.lat, pressureSystems);
    
    let steeringDirection = (Math.atan2(steerU, steerV) * 180 / Math.PI + 360) % 360;
    let angleDiff = steeringDirection - updatedCyclone.direction;
    while (angleDiff < -180) angleDiff += 360;
    while (angleDiff > 180) angleDiff -= 360;
    updatedCyclone.direction = (updatedCyclone.direction + angleDiff * 0.25 + 360) % 360;

    const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384; // 恢复为正确的物理单位转换 (m/s -> knots)
    updatedCyclone.speed += (steeringSpeedKnots - updatedCyclone.speed) * (0.15 + Math.max(0, updatedCyclone.lat / 100 - 0.15));

    if (updatedCyclone.speed < 5) {
        // 移速慢，增加冷却效应
        const coolingRate = (5 - updatedCyclone.speed) / 5 * 0.4; // 每帧最多冷却0.1°C
        updatedCyclone.upwellingCoolingEffect = Math.min(updatedCyclone.upwellingCoolingEffect + coolingRate, 5.0); // 冷却上限为5°C
    } else {
        // 移速快，冷却效应逐渐消散
        updatedCyclone.upwellingCoolingEffect = Math.max(updatedCyclone.upwellingCoolingEffect - 0.05, 0); // 缓慢恢复
    }

    let sst = getSST(updatedCyclone.lat, updatedCyclone.lon, month, globalTemp);
    sst -= updatedCyclone.upwellingCoolingEffect;
    const isRecurving = updatedCyclone.direction > 25 && updatedCyclone.direction < 155;
    if (!updatedCyclone.isTransitioning && sst < -8.0) {
        updatedCyclone.isTransitioning = true;
    }
    
    const oldIntensity = updatedCyclone.intensity;
    const isOverLand = world.features.some(feature => d3.geoContains(feature, [updatedCyclone.lon, updatedCyclone.lat]));
    const isNearLand = isNearLandSimple(updatedCyclone.lon, updatedCyclone.lat, world.features);
    const isNearOrOverLand = isOverLand || isNearLand;

    // --- 修改：集成地形影响 ---
    let terrainElevation = 0;
    if (isOverLand) {
        for (const feature of terrainFeatures) {
            if (d3.geoContains(feature, [updatedCyclone.lon, updatedCyclone.lat])) {
                terrainElevation = feature.properties.elevation;
                break;
            }
        }
    }

    if (terrainElevation > 0 && updatedCyclone.intensity > 45) {
        // 在高海拔地形上，强度和速度急剧衰减
        let weakeningFactor = 0.90 + updatedCyclone.circulationSize*0.0001 - (terrainElevation / 1000);
        updatedCyclone.intensity *= weakeningFactor; // 确保衰减，最少减半

    } else if (isNearOrOverLand) {
        // 在普通陆地上，正常衰减
        const JPAdjustment = (updatedCyclone.lat >= 30 && updatedCyclone.lat <= 40 && updatedCyclone.lon >= 130 && updatedCyclone.lon <= 140
) ? 0.04 : 0;
        const PHAdjustment = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 18 && updatedCyclone.lon >= 120 && updatedCyclone.lon <= 127 && updatedCyclone.intensity < 35
) ? 0.08 : 0;
        updatedCyclone.intensity *= 0.85 + updatedCyclone.circulationSize*0.0002 - Math.random()*0.01 - updatedCyclone.intensity / 1500 + JPAdjustment;
        updatedCyclone.speed *= 0.99;

    } else if (updatedCyclone.isExtratropical) {
        // --- Extratropical Cyclone Lifecycle Logic ---
        updatedCyclone.speed += 0.5; // Extratropical systems often accelerate

        if (updatedCyclone.extratropicalStage === 'developing') {
            // Check if development phase has ended
            if (updatedCyclone.age >= updatedCyclone.extratropicalDevelopmentEndTime) {
                updatedCyclone.extratropicalStage = 'decaying';
                 // Apply decay logic immediately in the same step
                const decayRate = -6 + Math.random() * 6; // -2 to 0
                updatedCyclone.intensity += decayRate;
            } else {
                // Still developing, apply intensification logic
                const divisor = 9 + Math.random() * 5; // 9 to 14
                const intensification = (updatedCyclone.extratropicalMaxIntensity - updatedCyclone.intensity) / divisor;
                updatedCyclone.intensity += intensification;
            }
        } else { // Stage is 'decaying'
            const decayRate = -2 + Math.random() * 2; // -2 to 0
            updatedCyclone.intensity += decayRate;
        }

    } else {
        let mpi = sst > 25.0 ? 264.28 * (1 - Math.exp(-0.182 * (sst - 25.00))) : 0;
        switch (updatedCyclone.ercState) {
            case 'weakening':
                // 削弱阶段：外眼墙形成，内眼墙开始瓦解
                mpi -= updatedCyclone.ercMpiReduction; // 持续抑制其潜能
                updatedCyclone.circulationSize *= 1.01; // 环流尺寸在此阶段显著增大

                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    // 削弱阶段结束，进入恢复阶段
                    updatedCyclone.ercState = 'recovering';
                    // 恢复阶段持续18-42小时
                    const recoveryDuration = 2 + Math.floor(Math.random() * 8);
                    updatedCyclone.ercEndTime = updatedCyclone.age + recoveryDuration * 3;
                }
                break;

            case 'recovering':
                // 恢复阶段：外眼墙完全替代内眼墙并开始收缩
                // MPI抑制解除，为再次增强创造条件
                // 环流尺寸缓慢收缩或稳定
                updatedCyclone.circulationSize *= 0.995;

                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    // ERC完全结束，恢复正常发展
                    updatedCyclone.ercState = 'none';
                    updatedCyclone.ercMpiReduction = 0;
                }
                break;

            default:
                // 正常状态：检查是否触发新的ERC
                // 条件：强度足够高(>96kt)，且并未处于其他特殊状态（如登陆、变性）
                if (updatedCyclone.intensity > 96 && !isOverLand && !updatedCyclone.isTransitioning && Math.random() < 0.15) {
                    // 触发新的ERC，进入削弱阶段
                    updatedCyclone.ercState = 'weakening';
                    // 削弱阶段持续12-36小时
                    const weakeningDuration = 4 + Math.floor(Math.random() * 9);
                    updatedCyclone.ercEndTime = updatedCyclone.age + weakeningDuration * 3;
                    // 设置一个在整个削弱阶段持续起作用的MPI抑制量
                    updatedCyclone.ercMpiReduction = 15 + Math.random() * 35; // MPI下降15-40
                    // 立即应用一次影响，以启动该过程
                    mpi -= updatedCyclone.ercMpiReduction;
                }
                break;
        }

        let ri = Math.random() > 0.97 ? Math.random() * 0.5 - 0.05 : 0;
        let intensificationRate = Math.random() * (0.14 + ri) * Math.min(1, ((updatedCyclone.intensity - 13) / 65));

        if (updatedCyclone.isMonsoonDepression) {
            intensificationRate *= (Math.random() + 0.05) * 0.25; // 速率降为正常的25%
        }
        const potentialChange = (mpi - updatedCyclone.intensity) * intensificationRate;
        const nioShearBoost = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 30 && updatedCyclone.lon >= 30 && updatedCyclone.lon <= 100
) ? 8.5 : 0;
        const shemShearBoost = (updatedCyclone.lat <= -5 && updatedCyclone.lat >= -30 && updatedCyclone.lon >= 50
) ? (30.0 * Math.sin((month - 2) * (Math.PI / 6))) : 0;
        const isWinterHalf = (month >= 11 || month <= 4);
        const shearEventProb = (isWinterHalf && updatedCyclone.lon > 100 && updatedCyclone.lon < 121 && updatedCyclone.lat > 16) ? 0.55 : (isWinterHalf ? 0.045 * (globalShear ** 2 / 10000) : 0.03 * (globalShear ** 2 / 10000));
        const latGradientFactor = updatedCyclone.lat > 0 ? (1.0 + 1.3 * Math.cos((month - 2) * (Math.PI / 6))) : (1.0 + 1.3 * Math.sin((month - 2) * (Math.PI / 6))); 
        let shear = updatedCyclone.lat > 0 ? Math.max(0, (Math.abs(updatedCyclone.lat) * latGradientFactor - (6 * Math.random()) - 30 + Math.cos((month - 2) * (Math.PI / 6)) * 40 + nioShearBoost)) / 15 : Math.max(0, (Math.abs(updatedCyclone.lat) * latGradientFactor - (6 * Math.random()) - 30 + Math.cos((month - 8) * (Math.PI / 6)) * 40 + nioShearBoost + shemShearBoost)) / 15;
        if (updatedCyclone.shearEventActive) {
            // 1. 如果事件正在发生，检查是否已到结束时间
            if (updatedCyclone.age >= updatedCyclone.shearEventEndTime) {
                // 事件结束，重置状态
                updatedCyclone.shearEventActive = false;
                updatedCyclone.shearEventMagnitude = 0;
            } else {
                // 事件仍在持续，应用其强度
                shear += updatedCyclone.shearEventMagnitude;
            }
        } else if (Math.random() < shearEventProb && !updatedCyclone.isTransitioning ) {
            // 2. 如果没有事件发生，则有 3% 的概率触发一个新事件
            updatedCyclone.shearEventActive = true;
            // 随机持续时间：3 到 48 小时 (以3小时为步进)
            const duration = (1 + Math.floor(Math.random() * 48)) * 3; 
            updatedCyclone.shearEventEndTime = updatedCyclone.age + duration;
            // 随机事件强度
            updatedCyclone.shearEventMagnitude = -3 + Math.random() * 7 + 1.9 * Math.abs(month - 8) ** 0.5 + Math.max(0,(globalShear / 10 - 10));
            console.log(shearEventProb);
            // 立即应用本次事件的强度
            shear += updatedCyclone.shearEventMagnitude;
        }
        
        updatedCyclone.intensity += (potentialChange - shear);
    }

    if ((!updatedCyclone.isExtratropical && sst < 25.5 && Math.abs(updatedCyclone.lat) > frontalZone.latitude) || (updatedCyclone.isSubtropical && sst < 25.5)) {
        updatedCyclone.isExtratropical = true;
        // --- New: Initialize Extratropical Lifecycle ---
        if (updatedCyclone.extratropicalStage === 'none') { // Ensure this only runs once
            if (Math.random() < 0.4 && Math.abs(updatedCyclone.lat) > 25) { // 50% chance to start in developing stage
                updatedCyclone.extratropicalStage = 'developing';
                // Duration: 24 to 96 hours (8 to 32 steps of 3 hours)
                const developmentDurationSteps = 4 + Math.floor(Math.random() * 25);
                updatedCyclone.extratropicalDevelopmentEndTime = updatedCyclone.age + (developmentDurationSteps * 3);
                // Max intensity for this stage: 45 to 90 knots
                updatedCyclone.extratropicalMaxIntensity = 45 + Math.random() * 45;
            } else {
                updatedCyclone.extratropicalStage = 'decaying';
            }
        }
    }

    if (updatedCyclone.isSubtropical &&
       (updatedCyclone.age >= updatedCyclone.subtropicalTransitionTime || updatedCyclone.isExtratropical)) {
        updatedCyclone.isSubtropical = false;
}

    const intensityChange = updatedCyclone.intensity - oldIntensity;
    if (updatedCyclone.isExtratropical || updatedCyclone.isTransitioning) {
        updatedCyclone.circulationSize *= 1.03;
    } else if (intensityChange > 0.5) {
        updatedCyclone.circulationSize *= 0.99;
    } else {
        updatedCyclone.circulationSize *= 1.002;
    }
    updatedCyclone.circulationSize = Math.max(100, Math.min(updatedCyclone.circulationSize, 800));

    updatedCyclone.intensity = Math.max(10, updatedCyclone.intensity);
    updatedCyclone = updateWindRadii(updatedCyclone);
    
    const currentSpeed = Math.max(2, updatedCyclone.speed);
    const finalStepDirection = updatedCyclone.direction + (Math.random() - 0.5) * 30;
    const angleRad = (90 - finalStepDirection) * (Math.PI / 180);
    const distanceDeg = currentSpeed * 3 * 1.852 / 111;

    let newLat = updatedCyclone.lat + distanceDeg * Math.sin(angleRad);
    let newLon = updatedCyclone.lon + distanceDeg * Math.cos(angleRad) / Math.cos(updatedCyclone.lat * Math.PI / 180);
    updatedCyclone.lon = normalizeLongitude(newLon); 
    updatedCyclone.lat = newLat;
    updatedCyclone.track.push([updatedCyclone.lon, updatedCyclone.lat, updatedCyclone.intensity, updatedCyclone.isTransitioning, updatedCyclone.isExtratropical, updatedCyclone.circulationSize, updatedCyclone.isSubtropical]);

    if (updatedCyclone.intensity < 17 || (updatedCyclone.isExtratropical && updatedCyclone.intensity < 25) || updatedCyclone.lat > 70 || updatedCyclone.lat < -70) {
        updatedCyclone.status = 'dissipated';
    }
    
    return updatedCyclone;
}
