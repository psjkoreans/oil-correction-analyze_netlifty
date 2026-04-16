// netlify/functions/analyze.js

/**
 * sRGB 색공간을 비선형 CIE L*a*b* 색공간으로 변환하는 수리적 함수
 * D65 표준 광원을 기준으로 Gamma Correction 수행
 */
function rgbToLab(r, g, b) {
    let r_l = r / 255.0, g_l = g / 255.0, b_l = b / 255.0;
    r_l = (r_l > 0.04045) ? Math.pow((r_l + 0.055) / 1.055, 2.4) : r_l / 12.92;
    g_l = (g_l > 0.04045) ? Math.pow((g_l + 0.055) / 1.055, 2.4) : g_l / 12.92;
    b_l = (b_l > 0.04045) ? Math.pow((b_l + 0.055) / 1.055, 2.4) : b_l / 12.92;

    let x = (r_l * 0.4124 + g_l * 0.3576 + b_l * 0.1805) * 100;
    let y = (r_l * 0.2126 + g_l * 0.7152 + b_l * 0.0722) * 100;
    let z = (r_l * 0.0193 + g_l * 0.1192 + b_l * 0.9505) * 100;

    x /= 95.047; y /= 100.000; z /= 108.883;

    x = (x > 0.008856) ? Math.pow(x, 1/3) : (7.787 * x) + (16 / 116);
    y = (y > 0.008856) ? Math.pow(y, 1/3) : (7.787 * y) + (16 / 116);
    z = (z > 0.008856) ? Math.pow(z, 1/3) : (7.787 * z) + (16 / 116);

    return { L: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const payload = JSON.parse(event.body); 
        
        // 페이로드 구조적 무결성 및 타입 검증 (방어적 프로그래밍)
        if (!Array.isArray(payload) || payload.length === 0) {
            throw new Error("Payload must be a non-empty array of objects.");
        }

        const isValid = payload.every(item => 
            typeof item.mileage === 'number' &&
            typeof item.r === 'number' && typeof item.g === 'number' && typeof item.b === 'number'
        );

        if (!isValid) {
            throw new Error("Invalid payload structure: missing required numerical fields.");
        }

        // 시계열 분석을 위한 주행거리 기준 오름차순 정렬 (O(n log n))
        payload.sort((a, b) => a.mileage - b.mileage);

        let cumulative_di = 0.0;
        const evaluatedData = [];

        // 누적 색차 기반 유클리드 거리 적분 및 5단계 상태 기계 산출
        for (let i = 0; i < payload.length; i++) {
            let row = payload[i];
            const lab = rgbToLab(row.r, row.g, row.b);
            
            row.L = lab.L;
            row.a = lab.a;
            row.b = lab.b;

            if (i === 0) {
                cumulative_di = 0.0;
            } else {
                const prevRow = evaluatedData[i - 1];
                const delta_e = Math.sqrt(
                    Math.pow(row.L - prevRow.L, 2) + 
                    Math.pow(row.a - prevRow.a, 2) + 
                    Math.pow(row.b - prevRow.b, 2)
                );
                cumulative_di += delta_e;
            }

            const is_saturated = row.L < 30.0;
            
            let phase, color;
            if (is_saturated || cumulative_di >= 250.0) {
                phase = 'Phase 5: 즉시 교체 필요 (Limit Reached)';
                color = '#000000'; // 검정색
            } else if (cumulative_di >= 225.0) {
                phase = 'Phase 4: 심화 열화(교체 필요)';
                color = '#8B0000'; // 진한 빨간색
            } else if (cumulative_di >= 200.0) {
                phase = 'Phase 3: 심화 열화 진행';
                color = '#FF0000'; // 빨간색
            } else if (cumulative_di >= 100.0) {
                phase = 'Phase 2: 열화 진행';
                color = '#FFA500'; // 주황색
            } else {
                phase = 'Phase 1: 초기 열화 또는 신유';
                color = '#FFD700'; // 노란색
            }

            evaluatedData.push({
                x: row.mileage,
                y: parseFloat(cumulative_di.toFixed(2)),
                L: parseFloat(row.L.toFixed(2)),
                a: parseFloat(row.a.toFixed(2)),
                b: parseFloat(row.b.toFixed(2)),
                phase: phase,
                needsReplacement: (is_saturated || cumulative_di >= 250.0),
                pointColor: color,
                isNew: row.isNew || false
            });
        }

        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ success: true, data: evaluatedData })
        };

    } catch (error) {
        return { 
            statusCode: 400, 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message }) 
        };
    }
}
