/**
 * visualization.js
 * 包含所有 D3.js 绘图函数。
 */
import { getCategory, getPressureAt, windToPressure } from './utils.js';

function drawWindRadii(mapSvg, pathGenerator, cyclone) {
    if (!cyclone || cyclone.intensity < 34) return;
    const windData = [
        { radius: cyclone.intensity > 60 ? cyclone.r64 : 0, color: "#c0392b" },
        { radius: cyclone.intensity > 45 ? cyclone.r50 : 0, color: "#e67e22" },
        { radius: cyclone.r34, color: "#f1c40f" }
    ];
    const stormDirRad = (90 - cyclone.direction) * (Math.PI / 180);
    const motionEffectKm = cyclone.speed * 1.5;

    windData.forEach(wind => {
        if (wind.radius <= 0) return;
        const baseRadiusKm = wind.radius;
        const allPoints = [];
        const numSegmentsPerQuadrant = 20;
        const quadrants = [
            { start: -Math.PI / 2, end: 0 },
            { start: 0, end: Math.PI / 2 },
            { start: Math.PI / 2, end: Math.PI },
            { start: Math.PI, end: 3 * Math.PI / 2 }
        ];

        quadrants.forEach(quad => {
            const quadCenterAngle = quad.start + (quad.end - quad.start) / 2;
            const angleToMotion = quadCenterAngle - stormDirRad;
            const quadMotionEffect = motionEffectKm * Math.cos(angleToMotion);
            const quadrantRadiusKm = Math.max(5, baseRadiusKm + quadMotionEffect);

            for (let i = 0; i <= numSegmentsPerQuadrant; i++) {
                const angle = quad.start + (i / numSegmentsPerQuadrant) * (quad.end - quad.start);
                const radiusDeg = quadrantRadiusKm / 111.32;
                const lonRadiusDeg = radiusDeg / Math.max(0.1, Math.cos(cyclone.lat * Math.PI / 180));
                const lon = cyclone.lon + lonRadiusDeg * Math.cos(angle);
                const lat = cyclone.lat + radiusDeg * Math.sin(angle);
                allPoints.push([lon, lat]);
            }
        });

        if (allPoints.length > 0) {
            // [修复1] 强制闭合
            allPoints.push(allPoints[0]);

            // [修复2] 保证方向逆时针
            if (d3.polygonArea(allPoints) < 0) {
                allPoints.reverse();
            }

            const polygonGeoJSON = { type: "Polygon", coordinates: [allPoints] };
            mapSvg.append("path")
                .datum(polygonGeoJSON)
                .attr("class", "wind-radii")
                .style("fill", wind.color)
                .style("fill-rule", "evenodd")   // [修复3]
                .style("stroke", d3.color(wind.color).darker(0.5))
                .attr("d", pathGenerator);
        }
    });
}

function drawForecastCone(mapSvg, mapProjection, pathForecasts) {
    if (!pathForecasts || pathForecasts.length === 0 || !pathForecasts[0].track || pathForecasts[0].track.length < 2) return;

    const forecastSteps = pathForecasts[0].track.length;
    const medianPath = [];
    const startPoint = pathForecasts[0].track[0];

    // --- [修正] 引入 lastLon 来处理日界线 ---
    let lastLon = startPoint[0]; 

    for (let i = 1; i < forecastSteps; i++) {
        const pointsAtStep = pathForecasts.map(f => f.track[i]);

        // --- [修正] “展开”经度以正确计算平均值 ---
        const unrolledPoints = pointsAtStep.map(p => {
            let lon = p[0];
            // 如果经度跳跃超过180度，则进行调整
            if (Math.abs(lon - lastLon) > 180) {
                if (lon < lastLon) {
                    lon += 360;
                } else {
                    lon -= 360;
                }
            }
            return [lon, p[1], p[2]]; // 返回包含展开经度的点
        });

        const avgLon = d3.mean(unrolledPoints, p => p[0]);
        const avgLat = d3.mean(unrolledPoints, p => p[1]);
        const avgIntensity = d3.mean(unrolledPoints, p => p[2]);
        
        medianPath.push([avgLon, avgLat, avgIntensity]);
        
        // --- [修正] 更新 lastLon 为当前步的平均经度 ---
        lastLon = avgLon;
    }
    
    const fullMedianPath = [startPoint, ...medianPath]; 
    const errorRadii = fullMedianPath.map((p, i) => 0.2 + i * 0.1125);

    if (fullMedianPath.length < 2) return;

    const circlesAsPointArrays = fullMedianPath.map((point, i) => {
        const radius = errorRadii[i];
        const numSegments = 32;
        const circlePoints = [];
        const lonRadius = radius / Math.max(0.1, Math.cos(point[1] * Math.PI / 180));

        for (let j = 0; j < numSegments; j++) {
            const angle = (j / numSegments) * 2 * Math.PI;
            circlePoints.push([
                point[0] + lonRadius * Math.cos(angle), 
                point[1] + radius * Math.sin(angle)
            ]);
        }
        return circlePoints;
    });

    const allCirclePoints = circlesAsPointArrays.flat();
    const hullPoints = d3.polygonHull(allCirclePoints);

    if (hullPoints) {
        const finalConePolygon = { type: "Polygon", coordinates: [hullPoints] };
        mapSvg.append("path")
            .datum(finalConePolygon)
            .attr("class", "forecast-cone")
            .attr("d", d3.geoPath().projection(mapProjection));
    }

    // --- 修改此处以显示强度 ---
    // [4, 8, 12, 16] 这些是 forecastSteps 的索引
    [8, 16, 24].forEach(stepIndex => {
        // 由于 fullMedianPath 包含了 startPoint，所以 medianPath 的索引需要修正
        // medianPath[stepIndex - 1] 对应 fullMedianPath[stepIndex]
        if (stepIndex < fullMedianPath.length) { // 检查 fullMedianPath 的长度
            const pointData = fullMedianPath[stepIndex]; // 获取包含 [lon, lat, intensity] 的点数据
            const [lon, lat, intensity] = pointData; // 解构获取强度
            
            // 如果 forecast 中的强度是 0，或者不显示强度，可以添加条件判断
            if (intensity && intensity > 15) { // 只有当强度大于0时才显示
                 const [px, py] = mapProjection([lon, lat]);
                 mapSvg.append("circle").attr("cx", px).attr("cy", py).attr("r", 3).attr("fill", "white");
                 mapSvg.append("text")
                     .attr("x", px)
                     .attr("y", py - 7)
                     .attr("class", "forecast-point-label")
                     // 修改 text 内容，添加强度
                     .text(`+${stepIndex * 3}h`); // 显示小时和强度
            }
        }
    });
}

function drawPressureField(mapSvg, mapProjection, pressureSystems) {
    const { width, height } = mapSvg.node().getBoundingClientRect();
    const nx = 80, ny = Math.round(nx * height / width), grid = [];
    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid.push(1012); continue;
            }
            grid.push(getPressureAt(coords[0], coords[1], pressureSystems));
        }
    }
    const contours = d3.contours().size([nx, ny]).thresholds(d3.range(990, 1050, 2));
    const transform = d3.geoTransform({ point: function(x, y) { this.stream.point(x * width / nx, y * height / ny); } });
    const pathGenerator = d3.geoPath().projection(transform);
    mapSvg.append("g").selectAll("path").data(contours(grid)).enter().append("path")
        .attr("class", d => d.value > 1012 ? "isobar" : "isobar-low").attr("d", pathGenerator);
}

// [新增] 辅助函数：计算地理坐标点周围指定半径（km）的圆周点
function createGeoCircle(centerLon, centerLat, radiusKm, numPoints = 64) {
    const coords = [];
    const earthRadiusKm = 6371;
    const radiusRad = radiusKm / earthRadiusKm; // Convert radius to radians
    const centerLatRad = centerLat * Math.PI / 180;
    const centerLonRad = centerLon * Math.PI / 180;

    for (let i = 0; i < numPoints; i++) {
        const bearing = (i / numPoints) * 2 * Math.PI; // Angle in radians

        // Haversine formula for destination point given distance and bearing
        const pointLatRad = Math.asin(Math.sin(centerLatRad) * Math.cos(radiusRad) +
                                   Math.cos(centerLatRad) * Math.sin(radiusRad) * Math.cos(bearing));
        let pointLonRad = centerLonRad + Math.atan2(Math.sin(bearing) * Math.sin(radiusRad) * Math.cos(centerLatRad),
                                                 Math.cos(radiusRad) - Math.sin(centerLatRad) * Math.sin(pointLatRad));

        // Convert back to degrees
        let pointLat = pointLatRad * 180 / Math.PI;
        let pointLon = pointLonRad * 180 / Math.PI;

        // Normalize longitude
        pointLon = (pointLon + 540) % 360 - 180;

        coords.push([pointLon, pointLat]);
    }
    coords.push(coords[0]); // Close the circle
    return { type: "LineString", coordinates: coords };
}

export function drawMap(mapSvg, mapProjection, world, cyclone, pathForecasts, pressureSystems, showPressureField, showPathForecast, showWindRadii, siteName, siteLon, siteLat) {
    if (!world || !mapSvg) return;
    mapSvg.selectAll("*").remove(); // Clear previous drawings
    const { width, height } = mapSvg.node().getBoundingClientRect();
    
    // Center map on the cyclone if it's active
    if (cyclone && cyclone.status === 'active') {
        mapProjection.center([cyclone.lon, cyclone.lat]).translate([width / 2, height / 2]);
    }
    
    const pathGenerator = d3.geoPath().projection(mapProjection);
    
    // Draw background and graticules
    mapSvg.append("rect").attr("width", width).attr("height", height).attr("fill", "#111827"); // Dark background
    mapSvg.append("path").datum(d3.geoGraticule().step([10, 10])).attr("class", "graticule").attr("d", pathGenerator);
    
    // Draw land features without borders
    mapSvg.append("g").selectAll("path").data(world.features).enter().append("path")
      .attr("class", "land")
      .attr("d", pathGenerator)
      .style("stroke", "none"); // Remove land borders

    // Draw optional layers if enabled and cyclone is active
    if (showPressureField && cyclone && cyclone.status === 'active') drawPressureField(mapSvg, mapProjection, pressureSystems);
    if (showWindRadii && cyclone && cyclone.status === 'active') drawWindRadii(mapSvg, pathGenerator, cyclone);

    // Draw forecast tracks and cone if enabled
    if (showPathForecast && pathForecasts && pathForecasts.length > 0) {
        drawForecastCone(mapSvg, mapProjection, pathForecasts);
        const colors = d3.scaleOrdinal(d3.schemeCategory10); // Color for individual forecast tracks
        pathForecasts.forEach((forecast, i) => {
            const forecastGeoJSON = { type: "LineString", coordinates: forecast.track };
            mapSvg.append("path").datum(forecastGeoJSON).attr("class", "forecast-track")
                .style("stroke", colors(i)).attr("d", pathGenerator);
        });
    }
    
    // Draw the historical track of the cyclone
    if (cyclone && cyclone.track && cyclone.track.length > 1) { // Check if track has at least 2 points
        for (let i = 0; i < cyclone.track.length - 1; i++) {
            const segment = { type: "LineString", coordinates: [cyclone.track[i].slice(0, 2), cyclone.track[i+1].slice(0, 2)] };
            // Get intensity and status flags from the *end* point of the segment
            const [, , intensity, isT, isE, , isS] = cyclone.track[i+1];
            const segmentColor = getCategory(intensity, isT, isE, isS).color; // Color based on category
            mapSvg.append("path").datum(segment).attr("class", "storm-track").style("stroke", segmentColor).attr("d", pathGenerator);
        }
    }

    // Draw the current cyclone position IF it's active
    if (cyclone && cyclone.status === 'active') {
        const [cx, cy] = mapProjection([cyclone.lon, cyclone.lat]);
        const iconColor = getCategory(cyclone.intensity, cyclone.isTransitioning, cyclone.isExtratropical, cyclone.isSubtropical).color;
        mapSvg.append("circle")
            .attr("cx", cx)
            .attr("cy", cy)
            .attr("r", 7)
            .attr("fill", iconColor)
            .attr("stroke", "white")
            .attr("stroke-width", 1.5);
    }

// --- Draw Site Marker, Labels, and Radius Circle (Last) ---
    if (siteLon != null && siteLat != null && isFinite(siteLon) && isFinite(siteLat)) {
        const proj = mapProjection([siteLon, siteLat]);
        if (proj) {
            const [siteX, siteY] = proj;

            // Draw marker
            mapSvg.append("rect") .attr("x", siteX - 4) .attr("y", siteY - 4) .attr("width", 8) .attr("height", 8)
                .attr("fill", "grey") .attr("stroke", "white") .attr("stroke-width", 1);

            // Draw Site Name Label
            if (siteName) {
                mapSvg.append("text") .attr("x", siteX + 6) .attr("y", siteY + 4) .attr("class", "site-label")
                       .style("fill", "white") .style("font-weight", "bold") .style("font-size", "10px")
                       .style("text-anchor", "start") .style("paint-order", "stroke") .style("stroke", "black") .style("stroke-width", "0.5px")
                    .text(siteName);
            }
        }
    }
}

export function drawFinalPath(mapSvg, mapProjection, cyclone, world, tooltip) {
    if (cyclone.track.length < 2) return;
    const { width, height } = mapSvg.node().getBoundingClientRect();
    const coords = cyclone.track.map(p => [p[0], p[1]]);
    const fullTrackGeoJSON = { type: "LineString", coordinates: coords };

    // Fit map to the track extent
    mapProjection.fitExtent([[30, 30], [width - 30, height - 30]], fullTrackGeoJSON);
    
    // Redraw the base map and the colored track segments
    drawMap(mapSvg, mapProjection, world, cyclone, [], [], false, false, false); 

    // --- NEW: Interactive Layer ---
    const interactionLayer = mapSvg.append("g");
    const highlightCircle = interactionLayer.append("circle")
        .attr("r", 9)
        .style("fill", "none")
        .style("stroke", "white")
        .style("stroke-width", "2px")
        .style("pointer-events", "none")
        .style("opacity", 0);

    mapSvg
        .on("mousemove", function(event) {
            const [mouseX, mouseY] = d3.pointer(event);
            let closestPoint = null;
            let minDistance = Infinity;

            // Find the closest track point to the mouse
            cyclone.track.forEach(pointData => {
                const [projX, projY] = mapProjection(pointData.slice(0, 2));
                const dx = mouseX - projX;
                const dy = mouseY - projY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = pointData;
                }
            });
            
            // If the mouse is close enough to the path
            if (closestPoint && minDistance < 30) { // Increased threshold to 30px
                const index = cyclone.track.indexOf(closestPoint);
                const time = `T+${index * 3} (h)`;
                const [lon, lat, intensity, isT, isE, , isS] = closestPoint;
                const category = getCategory(intensity, isT, isE, isS);
                const pressure = windToPressure(intensity, { circulationSize: 300 });

                // Update and show tooltip
                tooltip.transition().duration(50).style("opacity", .9);
                tooltip.html(
                    `<div style="text-align: center;">
                        <strong>${time}</strong><br/>
                        Vmax: ${intensity.toFixed(0)}kT<br/>
                        MSLP: ${pressure.toFixed(0)}hPa<br/>
                        Stat: ${category.shortName}<br/>
                        Lat: ${lat.toFixed(1)}N<br/>
                        Lon: ${lon.toFixed(1)}E
                    </div>`
                )
                .style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY - 28) + "px");
                
                // Move and show the highlight circle
                const [circleX, circleY] = mapProjection(closestPoint.slice(0, 2));
                highlightCircle
                    .attr("cx", circleX)
                    .attr("cy", circleY)
                    .style("fill", category.color)
                    .style("opacity", 1);

            } else {
                tooltip.style("opacity", 0);
                highlightCircle.style("opacity", 0);
            }
        })
        .on("mouseleave", function() {
            tooltip.style("opacity", 0);
            highlightCircle.style("opacity", 0);
        });
}

export function drawHistoricalIntensityChart(chartContainer, cycloneTrack, tooltip) {
    chartContainer.selectAll("*").remove();
    if (!cycloneTrack || cycloneTrack.length < 2) return;

    const { width, height } = chartContainer.node().getBoundingClientRect();
    const margin = {top: 20, right: 20, bottom: 30, left: 40};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const chartSvg = chartContainer.append("svg").attr("width", width).attr("height", height)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    
    const intensityData = cycloneTrack.map((point, index) => ({
        hour: index * 3,
        intensity: point[2],
        isT: point[3],
        isE: point[4],
        isS: point[6]
    }));

    const maxIntensity = d3.max(intensityData, d => d.intensity);
    const maxHour = intensityData[intensityData.length - 1].hour;

    const x = d3.scaleLinear().domain([0, maxHour]).range([0, innerWidth]);
    const y = d3.scaleLinear().domain([0, maxIntensity ? maxIntensity * 1.1 : 100]).range([innerHeight, 0]).nice();
    
    chartSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${innerHeight})`).call(d3.axisBottom(x).ticks(Math.min(10, maxHour / 12)).tickFormat(d => `T+${d}h`));
    chartSvg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d.toFixed(0)}kt`));

    const categoryBands = [
        { limit: 24, color: "#aaaaaa", name: "LPA" }, { limit: 34, color: "#5dade2", name: "TD" }, { limit: 64, color: "#2ecc71", name: "TS" },
        { limit: 83, color: "#f1c40f", name: "Cat 1" }, { limit: 96, color: "#f39c12", name: "Cat 2" },
        { limit: 113, color: "#e67e22", name: "Cat 3" }, { limit: 137, color: "#d35400", name: "Cat 4" },
        { limit: 300, color: "#c0392b", name: "Cat 5" }
    ];
    let lastY = y(0);
    categoryBands.forEach(band => {
        const yValue = y(band.limit);
        chartSvg.append("rect")
            .attr("x", 0).attr("y", yValue)
            .attr("width", innerWidth).attr("height", lastY - yValue)
            .attr("fill", band.color).attr("opacity", 0.2);
        lastY = yValue;
    });

    // [修正] 使用 d3.line() 来绘制折线图
    const lineGenerator = d3.line()
        .x(d => x(d.hour))
        .y(d => y(d.intensity));
    
    chartSvg.append("path")
        .datum(intensityData)
        .attr("class", "history-line")
        .attr("d", lineGenerator)
        .attr("fill", "none")
        .attr("stroke", "white")
        .attr("stroke-width", 2);

    // --- 交互功能 ---
    const focus = chartSvg.append("g").attr("class", "focus").style("display", "none");
    focus.append("line").attr("class", "focus-line").attr("y1", 0).attr("y2", innerHeight);
    focus.append("circle").attr("r", 5).attr("class", "focus-circle");

    chartSvg.append("rect")
        .attr("class", "overlay")
        .attr("width", innerWidth)
        .attr("height", innerHeight)
        .attr("fill", "none")
        .style("pointer-events", "all") // [修正] 确保透明层也能接收鼠标事件
        .on("mouseover", () => { focus.style("display", null); tooltip.style("opacity", .9); })
        .on("mouseout", () => { focus.style("display", "none"); tooltip.style("opacity", 0); })
        .on("mousemove", mousemove);

    const bisect = d3.bisector(d => d.hour).left;

    function mousemove(event) {
        const x0 = x.invert(d3.pointer(event)[0]);
        const i = bisect(intensityData, x0, 1);
        const d0 = intensityData[i - 1];
        const d1 = intensityData[i];
        if (!d0 || !d1) return;
        const d = x0 - d0.hour > d1.hour - x0 ? d1 : d0;
        
        focus.attr("transform", `translate(${x(d.hour)},${y(d.intensity)})`);
        focus.select(".focus-line").attr("y2", innerHeight - y(d.intensity));

        const category = getCategory(d.intensity, d.isT, d.isE, d.isS);
        tooltip.html(
            `<div style="text-align: center;">
                <strong>T+${d.hour}h</strong><br/>
                Vmax: ${d.intensity.toFixed(0)}kT<br/>
                Stat: ${category.shortName}
            </div>`
        )
        .style("left", (event.pageX + 15) + "px")
        .style("top", (event.pageY - 28) + "px");
    }
}
