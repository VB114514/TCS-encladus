//forecast-models.js
//负责生成各种数值模型的预报数据。
import { getSST, normalizeLongitude } from './utils.js';
import { calculateSteering, updatePressureSystems } from './cyclone-model.js';


export function generatePathForecasts(cyclone, pressureSystems) {
    const forecasts = [];
    const models = [
        { name: "ENAI", bias: { u: 0.5, v: -0.5 } },
    ];

    models.forEach(model => {
        let tempCyclone = JSON.parse(JSON.stringify(cyclone));
        let tempPressureSystems = JSON.parse(JSON.stringify(pressureSystems));
        let track = [[tempCyclone.lon, tempCyclone.lat]];

        for(let t = 0; t < 24; t += 1) { // 提高预报步数以获得更长的路径 (48 steps * 3h = 144h)
            updatePressureSystems(tempPressureSystems);
            const { steerU, steerV } = calculateSteering(tempCyclone.lon, tempCyclone.lat, tempPressureSystems, model.bias);
            
            let steeringDirection = (Math.atan2(steerU, steerV) * 180 / Math.PI + 360) % 360;
            let angleDiff = steeringDirection - tempCyclone.direction;
            while (angleDiff < -180) angleDiff += 360;
            while (angleDiff > 180) angleDiff -= 360;
            tempCyclone.direction = (tempCyclone.direction + angleDiff * 0.1 + 360) % 360;
            
            const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384;
            tempCyclone.speed += (steeringSpeedKnots - tempCyclone.speed) * 0.05;
            
            const currentSpeed = Math.max(3, tempCyclone.speed);
            const angleRad = (90 - tempCyclone.direction) * (Math.PI / 180);
            const distanceDeg = currentSpeed * 3 * 1.852 / 111;
            
            let newLat = tempCyclone.lat + distanceDeg * Math.sin(angleRad);
            let newLon = tempCyclone.lon + (distanceDeg * Math.cos(angleRad)) / Math.cos(tempCyclone.lat * Math.PI / 180);
            tempCyclone.lat = newLat;
            tempCyclone.lon = normalizeLongitude(newLon);
            
            track.push([tempCyclone.lon, tempCyclone.lat, tempCyclone.intensity, tempCyclone.isTransitioning || false, tempCyclone.isExtratropical || false]);
        }
        forecasts.push({ name: model.name, track: track });
    });
    return forecasts;

}
