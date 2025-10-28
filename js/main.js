/**
 * main.js
 * 应用程序的入口点。负责状态管理、事件处理和协调其他模块。
 */

// 从各模块导入函数
import { getCategory, knotsToKph, knotsToMph, windToPressure, directionToCompass } from './utils.js';
import { initializeCyclone, initializePressureSystems, updatePressureSystems, updateFrontalZone, updateCycloneState } from './cyclone-model.js';
// [修改] 移除不再需要的强度预报函数
import { generatePathForecasts } from './forecast-models.js';
// [修改] 引入新的历史强度图绘制函数
import { drawMap, drawFinalPath, drawHistoricalIntensityChart } from './visualization.js';

document.addEventListener('DOMContentLoaded', () => {

    // --- DOM 元素与全局状态 ---
    const generateButton = document.getElementById('generateButton');
    const pauseButton = document.getElementById('pauseButton');
    const basinSelector = document.getElementById('basinSelector');
    const monthSelector = document.getElementById('monthSelector');
    const togglePressureButton = document.getElementById('togglePressureButton');
    const toggleWindRadiiButton = document.getElementById('toggleWindRadiiButton');
    const togglePathButton = document.getElementById('togglePathButton');
    const copyTrackButton = document.getElementById('copy-track-button');
    const downloadTrackButton = document.getElementById('download-track-button');
    const bestTrackContainer = document.getElementById('best-track-container');
    const bestTrackData = document.getElementById('best-track-data');
    const mapContainer = d3.select("#map-container");
    const chartContainer = d3.select("#intensity-chart-container");
    const forecastContainer = document.getElementById('intensity-chart-section'); // [新增] 获取容器元素
    const tooltip = d3.select("body").append("div").attr("class", "tooltip");

    // [新增] 设置菜单 DOM 元素
    const settingsButton = document.getElementById('settingsButton');
    const settingsMenu = document.getElementById('settingsMenu');
    const globalTempSlider = document.getElementById('globalTempSlider');
    const globalTempValue = document.getElementById('globalTempValue');
    const globalShearSlider = document.getElementById('globalShearSlider');
    const globalShearValue = document.getElementById('globalShearValue');
    const siteNameInput = document.getElementById('siteNameInput');
    const siteLonInput = document.getElementById('siteLonInput');
    const siteLatInput = document.getElementById('siteLatInput');

    let state = {
        simulationInterval: null,
        isPaused: false,
        cyclone: {},
        pressureSystems: [],
        frontalZone: {},
        pathForecasts: [], // [修改] 移除 intensityForecasts 和 estimatedLifetime
        currentMonth: 7,
        world: null,
        showPressureField: false,
        showPathForecast: false,
        showWindRadii: false,
        GlobalShear: 100,
        GlobalTemp: 289, // [新增] 全局温度状态，默认 289K (16°C)
        siteName: '',
        siteLon: null,
        siteLat: null
    };

    let mapSvg, mapProjection;

    // --- 初始化与设置 ---

    function setupCanvases() {
        mapContainer.select("svg").remove();
        mapSvg = mapContainer.insert("svg", ":first-child").attr("width", "100%").attr("height", "100%");
        
        const { width, height } = mapContainer.node().getBoundingClientRect();
        mapProjection = d3.geoEquirectangular().scale(height / (20 * Math.PI / 180)).translate([width / 2, height / 2]);
    }
    
    d3.json("https://unpkg.com/world-atlas@2/countries-50m.json").then(data => {
        state.world = topojson.feature(data, data.objects.countries);
        setupCanvases();
        drawMap(mapSvg, mapProjection, state.world, {status: null, track: []}, [], state.pressureSystems, state.showPressureField, false, false, state.siteName, state.siteLon, state.siteLat);
    });

    // --- 辅助函数 ---

    function getAtcfTypeCode(windKts, isExtratropical, isSubtropical) {
        if (isSubtropical) {
            if (windKts < 34) return 'SD';
            return 'SS';
        }
        if (isExtratropical) return 'EX';
        if (windKts >= 130) return 'ST';
        if (windKts >= 64) return 'TY';
        if (windKts >= 34) return 'TS';
        if (windKts >= 24) return 'TD';
        if (windKts > 0) return 'DB';
        return 'LO';
    }

    function formatBestTrack(track, cycloneInfo) {
        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basin = basinMap[cycloneInfo.basin] || 'WP';
        const cycloneNum = '01';
        const startDate = new Date(Date.UTC(cycloneInfo.year, cycloneInfo.month - 1, 1));

        return track.map((point, index) => {
            const currentDate = new Date(startDate);
            currentDate.setUTCHours(currentDate.getUTCHours() + index * 3);

            const dateString = `${currentDate.getUTCFullYear()}${String(currentDate.getUTCMonth() + 1).padStart(2, '0')}${String(currentDate.getUTCDate()).padStart(2, '0')}${String(currentDate.getUTCHours()).padStart(2, '0')}`;
            const lat = `${Math.round(point[1] * 10)}N`;
            let lonValue = point[0] > 180 ? 360 - point[0] : point[0];
            let lonHemi = point[0] > 180 ? 'W' : 'E';
            const lon = `${Math.round(lonValue * 10)}${lonHemi}`;
            const vmax = Math.round(point[2]);
            const circulationSize = point[5]; 
            const isSubtropical = point[6];
            const mslp = Math.round(windToPressure(vmax, circulationSize));
            const type = getAtcfTypeCode(vmax, point[4], isSubtropical);

            return [
                basin.padEnd(2, ' '), cycloneNum.padStart(3, ' '), ` ${dateString}`, ' 00', ' BEST', '   0',
                lat.padStart(6, ' '), lon.padStart(7, ' '), String(vmax).padStart(4, ' '),
                String(mslp).padStart(5, ' '), ` ${type}`,
            ].join(',');
        }).join('\n');
    }

    // --- UI更新函数 ---

    function updateInfoPanel() {
        const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);
        document.getElementById('status').textContent = "模拟进行中...";
        document.getElementById('simulationTime').textContent = `模拟时间: T+${state.cyclone.age} 小时`;
        document.getElementById('latitude').textContent = `${state.cyclone.lat.toFixed(1)}°N`;
        document.getElementById('longitude').textContent = `${state.cyclone.lon.toFixed(1)}°E`;
        document.getElementById('intensity').textContent = `${knotsToKph(state.cyclone.intensity)} kph (${knotsToMph(state.cyclone.intensity)} mph)`;
        document.getElementById('pressure').textContent = `${windToPressure(state.cyclone.intensity, state.cyclone.circulationSize).toFixed(0)} hPa`;
        document.getElementById('category').textContent = cat.name;
        document.getElementById('ace').textContent = state.cyclone.ace.toFixed(2);
        document.getElementById('direction').textContent = `${directionToCompass(state.cyclone.direction)}`;
        document.getElementById('speed').textContent = `${state.cyclone.speed.toFixed(0)} kts`;
    }

    function updateMapInfoBox() {
        const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);
        document.getElementById('map-info-time').textContent = `T+${state.cyclone.age}h`;
        document.getElementById('map-info-intensity').textContent = `${cat.shortName} - ${state.cyclone.intensity.toFixed(0)}KT`;
        document.getElementById('map-info-movement').textContent = `${windToPressure(state.cyclone.intensity, state.cyclone.circulationSize).toFixed(0)}hPa ${directionToCompass(state.cyclone.direction)} ${state.cyclone.speed.toFixed(0)}KT`;
    }
    
    // --- 核心模拟循环 ---

    function updateSimulation() {
        if (state.cyclone.status !== 'active') {
            clearInterval(state.simulationInterval);
            state.simulationInterval = null;
            state.isPaused = false;
            document.getElementById('status').textContent = "模拟结束";
            document.getElementById('map-info-box').classList.add('hidden');
            pauseButton.disabled = true;
            pauseButton.textContent = "暂停";
            monthSelector.disabled = false;
            basinSelector.disabled = false;
            // [修改] 启用设置滑块
            globalTempSlider.disabled = false;
            globalShearSlider.disabled = false;
            siteNameInput.disabled = false;
            siteLonInput.disabled = false;
            siteLatInput.disabled = false;
            
            drawFinalPath(mapSvg, mapProjection, state.cyclone, state.world, tooltip);

            // [修正] 使用 setTimeout 延迟绘图，确保容器已渲染
            forecastContainer.classList.remove('hidden');
            setTimeout(() => {
                drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip);
            }, 0);

            const cycloneInfo = {
                basin: basinSelector.value,
                month: state.currentMonth,
                year: new Date().getFullYear()
            };
            bestTrackData.value = formatBestTrack(state.cyclone.track, cycloneInfo);
            bestTrackContainer.classList.remove('hidden');
            copyTrackButton.textContent = "复制数据";
            return;
        }
        
        // [修改] 传递 GlobalTemp 到模型
        state.pressureSystems = updatePressureSystems(state.pressureSystems, state.GlobalTemp, state.GlobalShear);
        state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.cyclone = updateCycloneState(state.cyclone, state.pressureSystems, state.frontalZone, state.world, state.currentMonth, state.GlobalTemp, state.GlobalShear);

        drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.pathForecasts, state.pressureSystems, state.showPressureField, state.showPathForecast, state.showWindRadii, state.siteName, state.siteLon, state.siteLat);
        updateInfoPanel();
        updateMapInfoBox();
        
        if (state.cyclone.age % 3 === 0 && state.cyclone.age > 0) {
             state.pathForecasts = generatePathForecasts(state.cyclone, state.pressureSystems);
        }
    }

    function startSimulation() {
        if (state.simulationInterval) clearInterval(state.simulationInterval);
        state.isPaused = false;
        if (!state.world) return;

        setupCanvases();
        document.getElementById('initial-message').classList.add('hidden');
        document.getElementById('simulation-output').classList.remove('hidden');
        forecastContainer.classList.add('hidden');
        document.getElementById('map-info-box').classList.remove('hidden');
        bestTrackContainer.classList.add('hidden');
        generateButton.textContent = "生成一个新气旋";
        pauseButton.disabled = false;
        pauseButton.textContent = "暂停";
        
        const selectedBasin = basinSelector.value;
        state.currentMonth = parseInt(monthSelector.value, 10);
        monthSelector.disabled = true;
        basinSelector.disabled = true;
        // [修改] 禁用设置滑块
        globalTempSlider.disabled = true;
        globalShearSlider.disabled = true;
        siteNameInput.disabled = true;
        siteLonInput.disabled = true;
        siteLatInput.disabled = true;
        settingsMenu.classList.add('hidden'); // [修改] 开始模拟时隐藏菜单

        // [修改] 传递 GlobalTemp 到模型
        state.cyclone = initializeCyclone(state.world, state.currentMonth, selectedBasin, state.GlobalTemp, state.GlobalShear); 
        state.cyclone.track.push([state.cyclone.lon, state.cyclone.lat, state.cyclone.intensity, false, false, state.cyclone.circulationSize, state.cyclone.isSubtropical]);
        state.pressureSystems = initializePressureSystems(state.cyclone, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        
        state.pathForecasts = generatePathForecasts(state.cyclone, state.pressureSystems);
        
        state.simulationInterval = setInterval(updateSimulation, 200);
    }
    
    function togglePause() {
        if (!state.cyclone.status || state.cyclone.status !== 'active') return;
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
            clearInterval(state.simulationInterval);
            state.simulationInterval = null;
            pauseButton.textContent = "继续";
            document.getElementById('status').textContent = "模拟已暂停";
        } else {
            state.simulationInterval = setInterval(updateSimulation, 200);
            pauseButton.textContent = "暂停";
            updateInfoPanel();
        }
    }

    function downloadBestTrack() {
        const text = bestTrackData.value;
        if (!text) return; // 如果没有数据则不执行

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        
        // 生成文件名，例如: best_track_WP_202507_随机编号.txt
        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basin = basinMap[basinSelector.value] || 'WP';
        const year = new Date().getFullYear();
        const month = String(state.currentMonth).padStart(2, '0');
        // 从格式化后的第一行提取气旋编号
        const firstLine = text.split('\n')[0];
        const cycloneNum = firstLine ? firstLine.split(',')[1].trim() : '01'; // 如果获取失败，默认为 01
        const filename = `best_track_${basin}${cycloneNum}_${year}${month}.txt`;

        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // --- 事件监听器 ---
    generateButton.addEventListener('click', startSimulation);
    pauseButton.addEventListener('click', togglePause);
    downloadTrackButton.addEventListener('click', downloadBestTrack);
    // [新增] 设置菜单事件监听器
    settingsButton.addEventListener('click', () => {
        settingsMenu.classList.toggle('hidden');
    });

    globalTempSlider.addEventListener('input', (e) => {
        state.GlobalTemp = parseInt(e.target.value, 10);
        globalTempValue.textContent = `${state.GlobalTemp}K`;
    });

    globalShearSlider.addEventListener('input', (e) => {
        state.GlobalShear = parseInt(e.target.value, 10);
        globalShearValue.textContent = `${state.GlobalShear}`;
    });

    // [新增] 实测站点输入框事件监听器
    siteNameInput.addEventListener('input', (e) => {
        state.siteName = e.target.value;
        // 即时重绘地图以显示/更新站点名称（如果已绘制）
        if (state.world && mapSvg) {
             drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.siteName, state.siteLon, state.siteLat);
        }
    });
    siteLonInput.addEventListener('input', (e) => {
        const lon = parseFloat(e.target.value);
        if (!isNaN(lon)) {
            state.siteLon = lon;
            if (state.world && mapSvg) {
                drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.siteName, state.siteLon, state.siteLat);
            }
        } else {
             state.siteLon = null; // 处理无效输入
        }
    });
    siteLatInput.addEventListener('input', (e) => {
        const lat = parseFloat(e.target.value);
         if (!isNaN(lat)) {
            state.siteLat = lat;
             if (state.world && mapSvg) {
                drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.siteName, state.siteLon, state.siteLat);
            }
        } else {
             state.siteLat = null; // 处理无效输入
        }
    });

    copyTrackButton.addEventListener('click', () => {
        bestTrackData.select();
        document.execCommand('copy');
        copyTrackButton.textContent = "已复制!";
    });

    togglePressureButton.addEventListener('click', () => {
        state.showPressureField = !state.showPressureField;
        togglePressureButton.classList.toggle('active');
        if (state.cyclone.status === 'active') {
            drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.pathForecasts, state.pressureSystems, state.showPressureField, state.showPathForecast, state.showWindRadii, state.siteName, state.siteLon, state.siteLat);
        }
    });

    toggleWindRadiiButton.addEventListener('click', () => {
        state.showWindRadii = !state.showWindRadii;
        toggleWindRadiiButton.classList.toggle('active');
        if (state.cyclone.status === 'active') {
            drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.pathForecasts, state.pressureSystems, state.showPressureField, state.showPathForecast, state.showWindRadii, state.siteName, state.siteLon, state.siteLat);
        }
    });

    togglePathButton.addEventListener('click', () => {
        state.showPathForecast = !state.showPathForecast;
        togglePathButton.classList.toggle('active');
        if (state.cyclone.status === 'active') {
            drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.pathForecasts, state.pressureSystems, state.showPressureField, state.showPathForecast, state.showWindRadii, state.siteName, state.siteLon, state.siteLat);
        }
    });
    
    window.addEventListener('resize', () => {
        if (state.world) {
            setupCanvases();
             if (state.cyclone.status) {
                 drawMap(mapSvg, mapProjection, state.world, state.cyclone, state.pathForecasts, state.pressureSystems, state.showPressureField, state.showPathForecast, state.showWindRadii, state.siteName, state.siteLon, state.siteLat);
             }
             if (state.cyclone.status && state.cyclone.status !== 'active') {
                 drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip);
             }
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
            event.preventDefault();
            togglePause();
        }
    });
});
