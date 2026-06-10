// --- Clock & Date Updater ---
function updateClock() {
    const clockElement = document.getElementById('clock');
    const dateElement = document.getElementById('date');
    if (!clockElement || !dateElement) return;
    const now = new Date();

    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    clockElement.textContent = `${hours}:${minutes}:${seconds}`;

    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateElement.textContent = now.toLocaleDateString(undefined, options);
}

setInterval(updateClock, 1000);
updateClock();

// --- UI Elements ---
const fullscreenBtn = document.getElementById('fullscreen-btn');
const dashboard = document.getElementById('dashboard');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const videoIdDisplay = document.getElementById('video-id-display');
const deleteBtn = document.getElementById('delete-btn');

const containerA = document.getElementById('player-container-a');
const containerB = document.getElementById('player-container-b');

// --- Switcher State ---
let playlist = []; 
let currentIndex = parseInt(localStorage.getItem('yt_current_index')) || 0;
let apiReady = false;

let playerA = null;
let playerB = null;
let activePlayerName = 'a'; // 'a' or 'b'
let isTransitioning = false;
let transitionTimeout = null;

// Track what video is loaded in which player
let loadedVideoA = '';
let loadedVideoB = '';

// --- WebSocket & Communication ---
let socket;
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.onopen = () => {
        console.log("Dashboard: WebSocket Connected");
        // Sync our current state to the console once connected
        setTimeout(syncStateToConsole, 1000);
    };
    
    socket.onmessage = (event) => {
        try {
            const config = JSON.parse(event.data);
            console.log("Dashboard: Command Received:", config);
            
            if (config.action === 'refresh_playlist') {
                fetchPlaylist();
            } else if (config.action === 'switch') {
                if (config.videoId) {
                    // Only play if video is starred (present in filtered playlist)
                    if (playlist.some(item => item.id === config.videoId)) {
                        transitionToVideo(config.videoId, config.transitionType || 'cut', config.duration);
                    } else {
                        console.log("Dashboard: Switch ignored because video is not starred.");
                    }
                }
            } else if (config.action === 'fade_tbar') {
                if (playlist.some(item => item.id === config.videoId)) {
                    handleTBarFade(config.videoId, config.value);
                } else {
                    console.log("Dashboard: Fade fader ignored because video is not starred.");
                }
            } else if (config.action === 'fade_complete') {
                finalizeTBarFade(config.videoId);
            } else if (config.action === 'request_sync') {
                syncStateToConsole();
            } else if (config.action === 'zoom_pan_live') {
                handleLiveZoomPan(config.videoId, config.zoom, config.panX, config.panY);
            }
        } catch (e) {
            console.error("Dashboard: Error parsing WebSocket message", e);
        }
    };

    socket.onclose = () => {
        console.log("Dashboard: WebSocket Closed. Reconnecting...");
        setTimeout(connectWebSocket, 3000);
    };
}
connectWebSocket();

const bc = new BroadcastChannel('dashboard_control');
bc.onmessage = (event) => {
    const config = event.data;
    if (config.action === 'refresh_playlist') {
        fetchPlaylist();
    } else if (config.action === 'switch' && config.videoId) {
        transitionToVideo(config.videoId, config.transitionType || 'cut', config.duration);
    }
};

function sendBroadcast(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
    }
    bc.postMessage(msg);
}

function syncStateToConsole() {
    if (playlist.length > 0 && playlist[currentIndex]) {
        sendBroadcast({
            action: 'sync_state',
            pgmVideoId: playlist[currentIndex].id,
            currentIndex: currentIndex
        });
    }
}

// --- Playlist Operations ---
async function fetchPlaylist() {
    try {
        const response = await fetch('/playlist');
        const data = await response.json();
        let rawList = data.playlist || [];
        
        playlist = rawList.map(item => {
            if (typeof item === 'string') {
                return { id: item, name: '', group: '', zoom: 1.0, panX: 0, panY: 0, starred: false };
            }
            return {
                id: item.id || '',
                name: item.name || '',
                group: item.group || '',
                zoom: item.zoom || 1.0,
                panX: item.panX || 0,
                panY: item.panY || 0,
                starred: !!item.starred
            };
        }).filter(item => item.id && item.starred); // Play ONLY starred items!
        
        localStorage.setItem('yt_playlist', JSON.stringify(playlist));
        console.log("Dashboard: Playlist Updated, starred count:", playlist.length);
        
        const noStarredOverlay = document.getElementById('no-starred-overlay');
        
        if (playlist.length === 0) {
            if (noStarredOverlay) noStarredOverlay.style.display = 'flex';
            if (playerA && playerA.stopVideo) playerA.stopVideo();
            if (playerB && playerB.stopVideo) playerB.stopVideo();
            loadedVideoA = '';
            loadedVideoB = '';
        } else {
            if (noStarredOverlay) noStarredOverlay.style.display = 'none';
            
            // If we transitioned from empty to active, start playing the first video
            if (apiReady) {
                const loadedVideo = activePlayerName === 'a' ? loadedVideoA : loadedVideoB;
                
                // If there's no video currently playing, or the playing video is no longer starred
                if (!loadedVideo || !playlist.some(v => v.id === loadedVideo)) {
                    currentIndex = 0;
                    const newVideoId = playlist[0].id;
                    const activeContainer = activePlayerName === 'a' ? containerA : containerB;
                    
                    if (activePlayerName === 'a') {
                        loadedVideoA = newVideoId;
                        applyZoomPanToPlayer('a', newVideoId);
                        if (playerA && playerA.loadVideoById) {
                            playerA.loadVideoById({ videoId: newVideoId });
                            playerA.mute();
                            playerA.playVideo();
                        }
                    } else {
                        loadedVideoB = newVideoId;
                        applyZoomPanToPlayer('b', newVideoId);
                        if (playerB && playerB.loadVideoById) {
                            playerB.loadVideoById({ videoId: newVideoId });
                            playerB.mute();
                            playerB.playVideo();
                        }
                    }
                    
                    activeContainer.style.opacity = '1';
                    activeContainer.classList.add('active');
                    updateDisplayMeta(newVideoId);
                }
            }
        }
        
        syncStateToConsole();
    } catch (error) {
        console.error("Dashboard: Fetch Playlist Failed:", error);
        let cached = localStorage.getItem('yt_playlist');
        if (cached) {
            try {
                let parsed = JSON.parse(cached);
                playlist = parsed.map(item => {
                    if (typeof item === 'string') return { id: item, name: '', group: '', zoom: 1.0, panX: 0, panY: 0, starred: false };
                    return {
                        id: item.id || '',
                        name: item.name || '',
                        group: item.group || '',
                        zoom: item.zoom || 1.0,
                        panX: item.panX || 0,
                        panY: item.panY || 0,
                        starred: !!item.starred
                    };
                }).filter(item => item.id && item.starred);
                
                const noStarredOverlay = document.getElementById('no-starred-overlay');
                if (playlist.length === 0) {
                    if (noStarredOverlay) noStarredOverlay.style.display = 'flex';
                    if (playerA && playerA.stopVideo) playerA.stopVideo();
                    if (playerB && playerB.stopVideo) playerB.stopVideo();
                    loadedVideoA = '';
                    loadedVideoB = '';
                } else {
                    if (noStarredOverlay) noStarredOverlay.style.display = 'none';
                }
            } catch(e) {
                playlist = [];
            }
        } else {
            playlist = [];
        }
    }
}

async function savePlaylistToServer() {
    try {
        await fetch('/playlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist: playlist })
        });
        sendBroadcast({ action: 'refresh_playlist' });
    } catch (error) {
        console.error("Dashboard: Sync to Server Failed:", error);
    }
}

// --- YouTube API Setup ---
window.onYouTubeIframeAPIReady = function() {
    console.log("Dashboard: YouTube API Loaded");
    fetchPlaylist().then(() => {
        const hasStarred = playlist.length > 0;
        if (currentIndex >= playlist.length) currentIndex = 0;
        
        const initialVideoId = hasStarred ? playlist[currentIndex].id : '';
        loadedVideoA = initialVideoId;
        
        console.log("Dashboard: Initializing Dual Players...");
        
        // Initialize Player A
        playerA = new YT.Player('player-a', {
            height: '100%',
            width: '100%',
            videoId: initialVideoId,
            playerVars: {
                'autoplay': hasStarred ? 1 : 0, 'mute': 1, 'controls': 0, 'showinfo': 0, 'rel': 0,
                'iv_load_policy': 3, 'modestbranding': 1, 'enablejsapi': 1
            },
            events: {
                'onReady': (e) => {
                    if (hasStarred) {
                        e.target.playVideo();
                        applyZoomPanToPlayer('a', initialVideoId);
                    }
                },
                'onStateChange': (e) => onPlayerStateChange(e, 'a')
            }
        });

        // Initialize Player B (Idle, loaded with same video or muted)
        playerB = new YT.Player('player-b', {
            height: '100%',
            width: '100%',
            videoId: initialVideoId,
            playerVars: {
                'autoplay': 0, 'mute': 1, 'controls': 0, 'showinfo': 0, 'rel': 0,
                'iv_load_policy': 3, 'modestbranding': 1, 'enablejsapi': 1
            },
            events: {
                'onReady': (e) => {
                    if (hasStarred) {
                        applyZoomPanToPlayer('b', initialVideoId);
                    }
                },
                'onStateChange': (e) => onPlayerStateChange(e, 'b')
            }
        });

        apiReady = true;
        
        const noStarredOverlay = document.getElementById('no-starred-overlay');
        if (hasStarred) {
            updateDisplayMeta(initialVideoId);
            if (noStarredOverlay) noStarredOverlay.style.display = 'none';
        } else {
            if (noStarredOverlay) noStarredOverlay.style.display = 'flex';
        }
        
        if (nextBtn) nextBtn.addEventListener('click', nextVideo);
        if (prevBtn) prevBtn.addEventListener('click', prevVideo);
    });
};

function onPlayerStateChange(event, playerCode) {
    // Auto loop / ensure play state
    if (event.data === YT.PlayerState.PAUSED && !isTransitioning) {
        event.target.playVideo();
    }
}

// --- Switching & Transitions ---
function transitionToVideo(videoId, type = 'cut', duration = 1000) {
    const activePlayer = activePlayerName === 'a' ? playerA : playerB;
    const inactivePlayer = activePlayerName === 'a' ? playerB : playerA;
    const activeContainer = activePlayerName === 'a' ? containerA : containerB;
    const inactiveContainer = activePlayerName === 'a' ? containerB : containerA;

    const currentLoadedVideo = activePlayerName === 'a' ? loadedVideoA : loadedVideoB;
    if (videoId === currentLoadedVideo) {
        console.log("Dashboard: Video already active on PGM.");
        return;
    }

    console.log(`Dashboard: Switching to ${videoId} via ${type.toUpperCase()}`);
    
    // Clear any running transition timeout
    if (transitionTimeout) clearTimeout(transitionTimeout);
    isTransitioning = true;

    // Set transition duration in CSS dynamically
    inactiveContainer.style.transition = `opacity ${duration}ms ease-in-out`;
    activeContainer.style.transition = `opacity ${duration}ms ease-in-out`;

    // Load video on the inactive player
    if (activePlayerName === 'a') {
        loadedVideoB = videoId;
        applyZoomPanToPlayer('b', videoId);
    } else {
        loadedVideoA = videoId;
        applyZoomPanToPlayer('a', videoId);
    }
    
    inactivePlayer.loadVideoById({ videoId: videoId, suggestedQuality: 'hd1080' });
    inactivePlayer.mute();
    inactivePlayer.playVideo();

    if (type === 'cut') {
        // Instant Switch
        inactiveContainer.style.opacity = '1';
        activeContainer.style.opacity = '0';
        
        inactiveContainer.classList.add('active');
        activeContainer.classList.remove('active');
        
        activePlayer.pauseVideo();
        activePlayerName = activePlayerName === 'a' ? 'b' : 'a';
        isTransitioning = false;
        
        updateDisplayMeta(videoId);
        updateLocalIndex(videoId);
    } else {
        // Auto Mix / Fade Transition
        // Wait briefly for buffering to begin
        setTimeout(() => {
            inactiveContainer.style.opacity = '1';
            activeContainer.style.opacity = '0';
            
            inactiveContainer.classList.add('active');
            activeContainer.classList.remove('active');
            
            transitionTimeout = setTimeout(() => {
                activePlayer.pauseVideo();
                activePlayerName = activePlayerName === 'a' ? 'b' : 'a';
                isTransitioning = false;
                
                updateDisplayMeta(videoId);
                updateLocalIndex(videoId);
            }, duration);
        }, 150);
    }
}

// --- T-Bar Manual Fade Transitions ---
function handleTBarFade(videoId, value) {
    // value is 0.0 to 1.0 (0.0 = Program is active, 1.0 = Preview is active)
    const activeContainer = activePlayerName === 'a' ? containerA : containerB;
    const inactiveContainer = activePlayerName === 'a' ? containerB : containerA;
    const inactivePlayer = activePlayerName === 'a' ? playerB : playerA;
    
    // Disable CSS animations during manual fade
    activeContainer.style.transition = 'none';
    inactiveContainer.style.transition = 'none';
    
    // Load video on inactive if not already loaded
    const inactiveLoadedVideo = activePlayerName === 'a' ? loadedVideoB : loadedVideoA;
    if (videoId !== inactiveLoadedVideo) {
        if (activePlayerName === 'a') {
            loadedVideoB = videoId;
            applyZoomPanToPlayer('b', videoId);
        } else {
            loadedVideoA = videoId;
            applyZoomPanToPlayer('a', videoId);
        }
        
        inactivePlayer.loadVideoById({ videoId: videoId, suggestedQuality: 'hd1080' });
        inactivePlayer.mute();
        inactivePlayer.playVideo();
    }
    
    // Adjust opacity manually based on fader value (0.0 to 1.0)
    activeContainer.style.opacity = (1 - value).toString();
    inactiveContainer.style.opacity = value.toString();
}

function finalizeTBarFade(videoId) {
    const activePlayer = activePlayerName === 'a' ? playerA : playerB;
    const inactiveContainer = activePlayerName === 'a' ? containerB : containerA;
    
    console.log("Dashboard: T-Bar transition complete to video:", videoId);
    
    // Re-enable CSS transitions
    containerA.style.transition = 'opacity 0.5s ease-in-out';
    containerB.style.transition = 'opacity 0.5s ease-in-out';
    
    inactiveContainer.classList.add('active');
    (activePlayerName === 'a' ? containerA : containerB).classList.remove('active');
    
    activePlayer.pauseVideo();
    activePlayerName = activePlayerName === 'a' ? 'b' : 'a';
    
    updateDisplayMeta(videoId);
    updateLocalIndex(videoId);
}

// --- Utility Helpers ---
function updateDisplayMeta(videoId) {
    if (!videoIdDisplay) return;
    const item = playlist.find(v => v.id === videoId);
    const displayName = item && item.name ? item.name : videoId;
    videoIdDisplay.textContent = `PGM OUT: ${displayName}`;
}

function updateLocalIndex(videoId) {
    const idx = playlist.findIndex(v => v.id === videoId);
    if (idx !== -1) {
        currentIndex = idx;
        localStorage.setItem('yt_current_index', currentIndex);
    }
}

function nextVideo() {
    if (playlist.length === 0) return;
    currentIndex = (currentIndex + 1) % playlist.length;
    const nextVideoId = playlist[currentIndex].id;
    transitionToVideo(nextVideoId, 'auto', 800);
    // Broadcast the new index
    sendBroadcast({
        action: 'sync_state',
        pgmVideoId: nextVideoId,
        currentIndex: currentIndex
    });
}

function prevVideo() {
    if (playlist.length === 0) return;
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    const prevVideoId = playlist[currentIndex].id;
    transitionToVideo(prevVideoId, 'auto', 800);
    // Broadcast the new index
    sendBroadcast({
        action: 'sync_state',
        pgmVideoId: prevVideoId,
        currentIndex: currentIndex
    });
}

function deleteCurrentVideo() {
    if (playlist.length <= 1) return;
    const deletedId = playlist[currentIndex].id;
    if (confirm(`Remove currently playing camera from playlist?`)) {
        playlist.splice(currentIndex, 1);
        localStorage.setItem('yt_playlist', JSON.stringify(playlist));
        savePlaylistToServer();
        
        if (currentIndex >= playlist.length) currentIndex = 0;
        const nextId = playlist[currentIndex].id;
        transitionToVideo(nextId, 'cut');
    }
}

if (deleteBtn) deleteBtn.addEventListener('click', deleteCurrentVideo);

// --- Zoom & Pan (DVE) Helpers ---
function applyZoomPanToPlayer(playerCode, videoId) {
    const playerEl = document.getElementById(`player-${playerCode}`);
    if (!playerEl) return;
    const item = playlist.find(v => v.id === videoId);
    if (item) {
        const z = item.zoom || 1.0;
        const px = item.panX || 0;
        const py = item.panY || 0;
        playerEl.style.transform = `scale(${z}) translate(${px}%, ${py}%)`;
    } else {
        playerEl.style.transform = 'none';
    }
}

function handleLiveZoomPan(videoId, zoom, panX, panY) {
    const item = playlist.find(v => v.id === videoId);
    if (item) {
        item.zoom = zoom;
        item.panX = panX;
        item.panY = panY;
    }
    
    if (loadedVideoA === videoId) {
        const pEl = document.getElementById('player-a');
        if (pEl) pEl.style.transform = `scale(${zoom}) translate(${panX}%, ${panY}%)`;
    }
    if (loadedVideoB === videoId) {
        const pEl = document.getElementById('player-b');
        if (pEl) pEl.style.transform = `scale(${zoom}) translate(${panX}%, ${panY}%)`;
    }
}

// --- Fullscreen & Idle Logic ---
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        dashboard.requestFullscreen().catch(err => {
            console.error("Error attempting to enable full-screen mode:", err);
        });
    } else {
        document.exitFullscreen();
    }
});

let idleTimer;
const idleDelay = 3000;
function resetIdleTimer() {
    if (dashboard) dashboard.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (dashboard) dashboard.classList.add('idle');
    }, idleDelay);
}

document.addEventListener('mousemove', resetIdleTimer);
document.addEventListener('keydown', (e) => {
    resetIdleTimer();
    const key = e.key.toLowerCase();
    if (key === 'arrowleft' || key === 'a') prevVideo();
    else if (key === 'arrowright' || key === 'd') nextVideo();
    else if (key === 'f') fullscreenBtn.click();
});
resetIdleTimer();
