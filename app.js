import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";

document.addEventListener('DOMContentLoaded', async () => {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('overlay');
    const ctx = canvas.getContext('2d');
    const loadingDiv = document.getElementById('loading');
    
    // UI Elements
    const countDisplay = document.getElementById('count-display');
    const timeDisplay = document.getElementById('time-display');
    const fpsInput = document.getElementById('fps-input');
    const fpsValue = document.getElementById('fps-value');
    
    // New UI Elements
    const cameraSelect = document.getElementById('camera-select');
    const lineAxisSelect = document.getElementById('line-axis-select');
    const countDirectionSelect = document.getElementById('count-direction-select');
    const dirForwardLabel = document.getElementById('dir-forward-label');
    const dirBackwardLabel = document.getElementById('dir-backward-label');
    const startTimeInput = document.getElementById('start-time');
    const endTimeInput = document.getElementById('end-time');
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const resetBtn = document.getElementById('reset-btn');
    const exportPdfBtn = document.getElementById('export-pdf-btn');
    const exportExcelBtn = document.getElementById('export-excel-btn');

    let objectDetector = null;
    let isDetecting = false;
    let isCounting = false;
    let count = 0;
    let crossingLogs = [];
    
    
    // Timer state
    let checkScheduleInterval = null;

    // Tracking state
    let nextTrackId = 0;
    let tracks = new Map(); 
    let countedIds = new Set();
    const MAX_INACTIVE_FRAMES = 10;
    const DISTANCE_THRESHOLD = 80;

    // Line state is now fixed based on UI selection

    // Get Cameras
    async function getCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            cameraSelect.innerHTML = '';
            videoDevices.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Camera ${index + 1}`;
                cameraSelect.appendChild(option);
            });
        } catch (e) {
            console.error("Error enumerating devices", e);
        }
    }

    // Initialize Camera
    async function setupCamera(deviceId = null) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            alert('เบราว์เซอร์ของคุณไม่รองรับการเข้าถึงกล้อง');
            return;
        }

        if (video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
        }

        const constraints = {
            video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } } 
                            : { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        };

        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            
            return new Promise((resolve) => {
                video.onloadedmetadata = () => {
                    resolve(video);
                };
            });
        } catch (e) {
            console.error("Error setting up camera", e);
            alert("ไม่สามารถเปิดใช้งานกล้องได้");
        }
    }

    cameraSelect.addEventListener('change', async (e) => {
        isDetecting = false;
        await setupCamera(e.target.value);
        resizeCanvas();
        video.play();
        isDetecting = true;
    });

    lineAxisSelect.addEventListener('change', (e) => {
        if (e.target.value === 'vertical') {
            dirForwardLabel.textContent = 'ซ้ายไปขวา';
            dirBackwardLabel.textContent = 'ขวาไปซ้าย';
        } else {
            dirForwardLabel.textContent = 'บนลงล่าง';
            dirBackwardLabel.textContent = 'ล่างขึ้นบน';
        }
    });

    // Load Model
    async function loadModel() {
        try {
            const vision = await FilesetResolver.forVisionTasks(
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
            );
            objectDetector = await ObjectDetector.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "efficientdet.tflite",
                    delegate: "CPU"
                },
                scoreThreshold: 0.5,
                runningMode: "VIDEO"
            });
            loadingDiv.classList.add('hidden');
        } catch (e) {
            console.error(e);
            loadingDiv.innerHTML = '<p style="color:red">เกิดข้อผิดพลาดในการโหลดโมเดล</p>';
        }
    }

    function resizeCanvas() {
        if (video.videoWidth) {
            canvas.width = video.clientWidth;
            canvas.height = video.clientHeight;
        }
    }
    window.addEventListener('resize', resizeCanvas);

    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    }

    function intersects(a, b, c, d) {
        let det, gamma, lambda;
        det = (a.x - b.x) * (c.y - d.y) - (c.x - d.x) * (a.y - b.y);
        if (det === 0) return false;
        lambda = ((c.y - d.y) * (c.x - a.x) + (d.x - c.x) * (c.y - a.y)) / det;
        gamma = ((b.y - a.y) * (c.x - a.x) + (a.x - b.x) * (c.y - a.y)) / det;
        return (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1);
    }

    const colors = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#38bdf8', '#818cf8', '#c084fc', '#f472b6'];
    
    let lastFrameTime = 0;
    
    async function detectFrame(timestamp) {
        if (!isDetecting) {
            requestAnimationFrame(detectFrame);
            return;
        }

        const fps = parseInt(fpsInput.value, 10);
        const frameInterval = 1000 / fps;

        if (timestamp - lastFrameTime >= frameInterval) {
            lastFrameTime = timestamp;
            
            if (objectDetector && video.readyState === 4) {
                const predictions = objectDetector.detectForVideo(video, performance.now());
                
                const scaleX = canvas.width / video.videoWidth;
                const scaleY = canvas.height / video.videoHeight;

                const currentCentroids = [];

                if (predictions.detections) {
                    predictions.detections.forEach(pred => {
                        const category = pred.categories[0].categoryName;
                        if (category === 'person') {
                            const { originX, originY, width, height } = pred.boundingBox;
                            const cx = (originX + width / 2) * scaleX;
                            const cy = (originY + height / 2) * scaleY;
                            currentCentroids.push({ 
                                cx, cy, 
                                bbox: [originX * scaleX, originY * scaleY, width * scaleX, height * scaleY] 
                            });
                        }
                    });
                }

                updateTracks(currentCentroids);
                drawOverlay(currentCentroids);
            }
        }
        requestAnimationFrame(detectFrame);
    }

    function updateTracks(currentCentroids) {
        for (let [id, track] of tracks.entries()) {
            track.inactiveFrames++;
        }

        currentCentroids.forEach(cent => {
            let bestMatchId = -1;
            let minDistance = Infinity;

            for (let [id, track] of tracks.entries()) {
                const dist = getDistance(track, { x: cent.cx, y: cent.cy });
                if (dist < minDistance && dist < DISTANCE_THRESHOLD) {
                    minDistance = dist;
                    bestMatchId = id;
                }
            }

            let trackId;
            if (bestMatchId !== -1) {
                const track = tracks.get(bestMatchId);
                const prev = { x: track.x, y: track.y };
                const curr = { x: cent.cx, y: cent.cy };
                
                track.x = cent.cx;
                track.y = cent.cy;
                track.inactiveFrames = 0;
                trackId = bestMatchId;

                if (isCounting) {
                    const cx = canvas.width / 2;
                    const cy = canvas.height / 2;
                    let lineA, lineB;

                    if (lineAxisSelect.value === 'vertical') {
                        lineA = { x: cx, y: 0 };
                        lineB = { x: cx, y: canvas.height };
                    } else {
                        lineA = { x: 0, y: cy };
                        lineB = { x: canvas.width, y: cy };
                    }
                    
                    if (intersects(prev, curr, lineA, lineB)) {
                        let isDirectionMatch = false;
                        const direction = countDirectionSelect.value;
                        if (lineAxisSelect.value === 'vertical') {
                            if (direction === 'both') isDirectionMatch = true;
                            else if (direction === 'forward') isDirectionMatch = prev.x < curr.x;
                            else if (direction === 'backward') isDirectionMatch = prev.x > curr.x;
                        } else {
                            if (direction === 'both') isDirectionMatch = true;
                            else if (direction === 'forward') isDirectionMatch = prev.y < curr.y;
                            else if (direction === 'backward') isDirectionMatch = prev.y > curr.y;
                        }

                        if (isDirectionMatch && !countedIds.has(trackId)) {
                            count++;
                            crossingLogs.push({ "Person Number": count, "Crossing Time": new Date().toLocaleTimeString() });
                            countDisplay.textContent = count;
                            countedIds.add(trackId);
                            document.querySelector('.stat-box').style.backgroundColor = 'rgba(74, 222, 128, 0.4)';
                            setTimeout(() => {
                                document.querySelector('.stat-box').style.backgroundColor = 'rgba(0,0,0,0.2)';
                            }, 300);
                        }
                    }
                }
            } else {
                trackId = nextTrackId++;
                tracks.set(trackId, {
                    x: cent.cx,
                    y: cent.cy,
                    inactiveFrames: 0,
                    color: colors[trackId % colors.length]
                });
            }
        });

        for (let [id, track] of tracks.entries()) {
            if (track.inactiveFrames > MAX_INACTIVE_FRAMES) {
                tracks.delete(id);
            }
        }
    }

    function drawOverlay(currentCentroids) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        let lx1, ly1, lx2, ly2;

        if (lineAxisSelect.value === 'vertical') {
            lx1 = cx; ly1 = 0;
            lx2 = cx; ly2 = canvas.height;
        } else {
            lx1 = 0; ly1 = cy;
            lx2 = canvas.width; ly2 = cy;
        }

        ctx.beginPath();
        ctx.moveTo(lx1, ly1);
        ctx.lineTo(lx2, ly2);
        ctx.strokeStyle = 'var(--line-color)';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 10]);
        ctx.stroke();
        ctx.setLineDash([]);

        currentCentroids.forEach(cent => {
            let color = '#fff';
            let trackId = '?';
            for (let [id, track] of tracks.entries()) {
                if (track.x === cent.cx && track.y === cent.cy) {
                    color = track.color;
                    trackId = id;
                    break;
                }
            }

            const [x, y, w, h] = cent.bbox;
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(cent.cx, cent.cy, 5, 0, 2 * Math.PI);
            ctx.fill();

            ctx.fillStyle = color;
            ctx.font = '14px Prompt';
            ctx.fillText(`ID: ${trackId}`, x, y > 20 ? y - 5 : y + 20);
        });
    }



    fpsInput.addEventListener('input', (e) => {
        fpsValue.textContent = `${e.target.value} FPS`;
    });

    startBtn.addEventListener('click', () => {
        const startVal = startTimeInput.value;
        const endVal = endTimeInput.value;

        if (!startVal || !endVal) {
            alert('กรุณาระบุช่วงเวลาให้ครบถ้วน');
            return;
        }

        startBtn.disabled = true;
        stopBtn.disabled = false;
        startTimeInput.disabled = true;
        endTimeInput.disabled = true;

        count = 0;
        crossingLogs = [];
        countedIds.clear();
        countDisplay.textContent = count;

        const [startH, startM] = startVal.split(':');
        const startMs = parseInt(startH) * 3600000 + parseInt(startM) * 60000;
        const [endH, endM] = endVal.split(':');
        const endMs = parseInt(endH) * 3600000 + parseInt(endM) * 60000;

        checkScheduleInterval = setInterval(() => {
            const now = new Date();
            const currentMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000;
            
            let inRange = false;
            if (startMs <= endMs) {
                inRange = (currentMs >= startMs && currentMs <= endMs);
            } else {
                inRange = (currentMs >= startMs || currentMs <= endMs);
            }

            if (inRange) {
                isCounting = true;
                timeDisplay.textContent = "กำลังทำงาน";
                timeDisplay.style.color = "var(--accent-color)";
            } else {
                isCounting = false;
                if (startMs <= endMs && currentMs > endMs && count > 0) {
                     stopCounting();
                     alert(`จบช่วงเวลานับคนตามกำหนด! จำนวนทั้งหมด ${count} คน\nระบบกำลังส่งออกไฟล์สรุป (PDF และ Excel)`);
                     exportPDF();
                     exportExcel();
                } else {
                     timeDisplay.textContent = "นอกช่วงเวลา";
                     timeDisplay.style.color = "var(--text-secondary)";
                }
            }
        }, 1000);
    });

    function stopCounting() {
        isCounting = false;
        clearInterval(checkScheduleInterval);
        startBtn.disabled = false;
        stopBtn.disabled = true;
        startTimeInput.disabled = false;
        endTimeInput.disabled = false;
        timeDisplay.textContent = "--:--";
        timeDisplay.style.color = "var(--text-primary)";
    }

    stopBtn.addEventListener('click', stopCounting);

    resetBtn.addEventListener('click', () => {
        stopCounting();
        count = 0;
        crossingLogs = [];
        countDisplay.textContent = '0';
        timeDisplay.textContent = '--:--';
        countedIds.clear();
        tracks.clear();
    });

    function exportPDF() {
        if (!window.jspdf) { alert("PDF library is loading..."); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.setFontSize(20);
        doc.text("People Counting Summary", 20, 20);
        
        doc.setFontSize(14);
        doc.text(`Date: ${new Date().toLocaleDateString()}`, 20, 35);
        doc.text(`Schedule: ${startTimeInput.value} to ${endTimeInput.value}`, 20, 45);
        doc.text(`Total People Count: ${count}`, 20, 55);
        
        doc.save(`People_Count_Summary_${new Date().getTime()}.pdf`);
    }

    function exportExcel() {
        if (!window.XLSX) { alert("Excel library is loading..."); return; }
        const wsData = [
            ["People Counting Report"],
            ["Date:", new Date().toLocaleDateString()],
            ["Schedule:", `${startTimeInput.value} to ${endTimeInput.value}`],
            ["Total Count:", count],
            [],
            ["Person Number", "Crossing Time"]
        ];

        crossingLogs.forEach(log => {
            wsData.push([log["Person Number"], log["Crossing Time"]]);
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, "Report");
        XLSX.writeFile(wb, `People_Count_Report_${new Date().getTime()}.xlsx`);
    }

    exportPdfBtn.addEventListener('click', exportPDF);
    exportExcelBtn.addEventListener('click', exportExcel);

    // Bootup
    await setupCamera();
    await getCameras(); // Call after getting permission so labels are populated
    
    resizeCanvas();
    video.play();
    await loadModel();
    
    isDetecting = true;
    requestAnimationFrame(detectFrame);
});
