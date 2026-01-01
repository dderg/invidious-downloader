/**
 * Dashboard UI for the downloader service.
 * Single-page HTML dashboard with vanilla JS.
 */

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invidious Downloader</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --bg-card: #16213e;
      --bg-input: #0f0f23;
      --text: #eee;
      --text-muted: #888;
      --accent: #e94560;
      --success: #4ade80;
      --warning: #fbbf24;
      --error: #f87171;
      --border: #333;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    h1 {
      font-size: 24px;
      font-weight: 600;
    }
    
    .status-badge {
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
    }
    
    .status-ok { background: var(--success); color: #000; }
    .status-degraded { background: var(--warning); color: #000; }
    .status-error { background: var(--error); color: #000; }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .stat-card {
      background: var(--bg-card);
      padding: 20px;
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    
    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--accent);
    }
    
    .stat-label {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    
    .card {
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 24px;
      overflow: hidden;
    }
    
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .card-header h2 {
      font-size: 18px;
      font-weight: 600;
    }
    
    .card-body {
      padding: 20px;
    }
    
    .download-form {
      display: flex;
      gap: 12px;
    }
    
    .download-form input {
      flex: 1;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-input);
      color: var(--text);
      font-size: 16px;
    }
    
    .download-form input:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    .download-form input::placeholder {
      color: var(--text-muted);
    }
    
    button {
      padding: 12px 24px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: white;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    
    button:hover {
      opacity: 0.9;
    }
    
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    button.secondary {
      background: var(--border);
    }
    
    .queue-list, .downloads-list {
      list-style: none;
    }
    
    .queue-item, .download-item {
      display: flex;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      gap: 16px;
    }
    
    .queue-item:last-child, .download-item:last-child {
      border-bottom: none;
    }
    
    .item-thumbnail {
      width: 120px;
      height: 68px;
      background: var(--bg);
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    
    .item-thumbnail img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .item-info {
      flex: 1;
      min-width: 0;
    }
    
    .item-title {
      font-weight: 500;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .item-meta {
      font-size: 13px;
      color: var(--text-muted);
    }
    
    .item-status {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
    }
    
    .status-pending { background: var(--warning); color: #000; }
    .status-downloading { background: var(--accent); color: #fff; }
    .status-completed { background: var(--success); color: #000; }
    .status-failed { background: var(--error); color: #000; }
    .status-cancelled { background: var(--border); color: var(--text); }
    
    .item-actions {
      display: flex;
      gap: 8px;
    }
    
    .item-actions button {
      padding: 6px 12px;
      font-size: 13px;
    }
    
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
    }
    
    .progress-bar {
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin-top: 8px;
      overflow: hidden;
    }
    
    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s;
    }
    
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
    }
    
    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    
    .toast.success { border-color: var(--success); }
    .toast.error { border-color: var(--error); }
    
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
    }
    
    .tab {
      padding: 8px 16px;
      border-radius: 6px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      border: none;
      font-size: 14px;
    }
    
    .tab:hover {
      background: var(--border);
      color: var(--text);
    }
    
    .tab.active {
      background: var(--accent);
      color: white;
    }
    
    .refresh-indicator {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    @media (max-width: 600px) {
      .download-form {
        flex-direction: column;
      }
      
      .queue-item, .download-item {
        flex-direction: column;
        align-items: flex-start;
      }
      
      .item-thumbnail {
        width: 100%;
        height: auto;
        aspect-ratio: 16/9;
      }
      
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Invidious Downloader</h1>
      <div>
        <span class="refresh-indicator">Auto-refresh: <span id="countdown">5</span>s</span>
        <span id="status-badge" class="status-badge status-ok">OK</span>
      </div>
    </header>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="stat-active">0</div>
        <div class="stat-label">Active Downloads</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-queue">0</div>
        <div class="stat-label">In Queue</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-total">0</div>
        <div class="stat-label">Total Downloaded</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-size">0 GB</div>
        <div class="stat-label">Total Size</div>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Download Video</h2>
      </div>
      <div class="card-body">
        <form class="download-form" id="download-form">
          <input 
            type="text" 
            id="video-input" 
            placeholder="Enter YouTube video ID or URL (e.g., dQw4w9WgXcQ or https://youtube.com/watch?v=...)"
          >
          <button type="submit">Download</button>
        </form>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Queue</h2>
        <button class="secondary" onclick="clearCompleted()">Clear Completed</button>
      </div>
      <div id="queue-container">
        <ul class="queue-list" id="queue-list"></ul>
      </div>
    </div>
    
    <div class="card">
      <div class="card-header">
        <h2>Downloaded Videos</h2>
        <span class="refresh-indicator" id="downloads-count">0 videos</span>
      </div>
      <div id="downloads-container">
        <ul class="downloads-list" id="downloads-list"></ul>
      </div>
    </div>
  </div>
  
  <div class="toast" id="toast"></div>
  
  <script>
    const API_BASE = '/api/downloader';
    let refreshInterval;
    let countdown = 5;
    
    // ========================================================================
    // API Functions
    // ========================================================================
    
    async function fetchStatus() {
      const res = await fetch(API_BASE + '/status');
      return res.json();
    }
    
    async function fetchQueue() {
      const res = await fetch(API_BASE + '/queue');
      return res.json();
    }
    
    async function fetchProgress() {
      const res = await fetch(API_BASE + '/progress');
      return res.json();
    }
    
    async function fetchDownloads(limit = 20) {
      const res = await fetch(API_BASE + '/downloads?limit=' + limit + '&orderBy=downloadedAt&orderDir=desc');
      return res.json();
    }
    
    async function addToQueue(videoId) {
      const res = await fetch(API_BASE + '/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId })
      });
      return res.json();
    }
    
    async function cancelDownload(videoId) {
      const res = await fetch(API_BASE + '/queue/' + videoId, { method: 'DELETE' });
      return res.json();
    }
    
    async function clearCompletedQueue() {
      const res = await fetch(API_BASE + '/queue/clear', { method: 'POST' });
      return res.json();
    }
    
    // ========================================================================
    // UI Functions
    // ========================================================================
    
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    function formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    function extractVideoId(input) {
      input = input.trim();
      
      // Already a video ID
      if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        return input;
      }
      
      // YouTube URL patterns
      const patterns = [
        /(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/|youtube\\.com\\/embed\\/|youtube\\.com\\/v\\/)([a-zA-Z0-9_-]{11})/,
        /[?&]v=([a-zA-Z0-9_-]{11})/
      ];
      
      for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) return match[1];
      }
      
      return null;
    }
    
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast ' + type + ' show';
      setTimeout(() => toast.classList.remove('show'), 3000);
    }
    
    function getThumbnailUrl(videoId) {
      return 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg';
    }
    
    // ========================================================================
    // Render Functions
    // ========================================================================
    
    function renderStatus(status) {
      document.getElementById('stat-active').textContent = status.activeDownloads;
      document.getElementById('stat-queue').textContent = status.queueLength;
      document.getElementById('stat-total').textContent = status.totalDownloads;
      document.getElementById('stat-size').textContent = formatBytes(status.totalSizeBytes);
      
      const badge = document.getElementById('status-badge');
      badge.textContent = status.status.toUpperCase();
      badge.className = 'status-badge status-' + status.status;
    }
    
    function formatSpeed(bytesPerSec) {
      if (!bytesPerSec) return '';
      return formatBytes(bytesPerSec) + '/s';
    }
    
    function getPhaseLabel(phase) {
      const labels = {
        'downloading_video': 'Downloading video',
        'downloading_audio': 'Downloading audio',
        'muxing': 'Muxing...',
        'queued': 'Queued'
      };
      return labels[phase] || phase;
    }
    
    // Store progress data globally for merging with queue
    let currentProgress = {};
    
    function renderQueue(data) {
      const list = document.getElementById('queue-list');
      
      if (!data.items || data.items.length === 0) {
        list.innerHTML = '<li class="empty-state">No items in queue</li>';
        return;
      }
      
      list.innerHTML = data.items.map(item => {
        // Get progress info for this item if it's actively downloading
        const progress = currentProgress[item.videoId];
        const percentage = progress?.percentage ?? 0;
        const phase = progress?.phase ?? item.status;
        const speed = progress?.speed;
        const downloaded = progress?.bytesDownloaded ?? 0;
        const total = progress?.totalBytes;
        const title = progress?.title || item.title || item.videoId;
        
        const isActive = item.status === 'downloading' || item.status === 'muxing';
        const progressText = isActive && progress 
          ? \`\${getPhaseLabel(phase)} - \${formatBytes(downloaded)}\${total ? ' / ' + formatBytes(total) : ''}\${speed ? ' (' + formatSpeed(speed) + ')' : ''}\`
          : '';
        
        return \`
          <li class="queue-item" data-video-id="\${item.videoId}">
            <div class="item-thumbnail">
              <img src="\${getThumbnailUrl(item.videoId)}" alt="" loading="lazy">
            </div>
            <div class="item-info">
              <div class="item-title">\${title}</div>
              <div class="item-meta">
                \${item.channelTitle || 'Unknown channel'} 
                &bull; Added \${formatDate(item.queuedAt)}
                \${item.errorMessage ? '&bull; <span style="color: var(--error)">' + item.errorMessage + '</span>' : ''}
              </div>
              \${isActive ? \`
                <div class="item-meta progress-text" style="color: var(--accent)">\${progressText}</div>
                <div class="progress-bar">
                  <div class="progress-fill" style="width: \${percentage}%"></div>
                </div>
              \` : ''}
            </div>
            <span class="item-status status-\${item.status}">\${item.status}</span>
            <div class="item-actions">
              \${item.status === 'pending' || item.status === 'downloading' ? \`
                <button class="secondary" onclick="cancelItem('\${item.videoId}')">Cancel</button>
              \` : ''}
              \${item.status === 'failed' ? \`
                <button onclick="retryItem('\${item.videoId}')">Retry</button>
              \` : ''}
            </div>
          </li>
        \`;
      }).join('');
    }
    
    function renderDownloads(data) {
      const list = document.getElementById('downloads-list');
      document.getElementById('downloads-count').textContent = data.count + ' videos';
      
      if (!data.items || data.items.length === 0) {
        list.innerHTML = '<li class="empty-state">No downloaded videos yet</li>';
        return;
      }
      
      list.innerHTML = data.items.map(item => \`
        <li class="download-item">
          <div class="item-thumbnail">
            <img src="\${getThumbnailUrl(item.videoId)}" alt="" loading="lazy">
          </div>
          <div class="item-info">
            <div class="item-title">\${item.title || item.videoId}</div>
            <div class="item-meta">
              \${item.channelTitle || 'Unknown'} 
              &bull; \${formatBytes(item.fileSizeBytes || 0)}
              &bull; Downloaded \${formatDate(item.downloadedAt)}
            </div>
          </div>
          <div class="item-actions">
            <button class="secondary" onclick="window.open('/watch?v=\${item.videoId}', '_blank')">Watch</button>
          </div>
        </li>
      \`).join('');
    }
    
    // ========================================================================
    // Actions
    // ========================================================================
    
    async function cancelItem(videoId) {
      try {
        await cancelDownload(videoId);
        showToast('Download cancelled');
        refresh();
      } catch (err) {
        showToast('Failed to cancel: ' + err.message, 'error');
      }
    }
    
    async function retryItem(videoId) {
      try {
        // Cancel first to remove from queue, then re-add
        await cancelDownload(videoId);
        await addToQueue(videoId);
        showToast('Retrying download');
        refresh();
      } catch (err) {
        showToast('Failed to retry: ' + err.message, 'error');
      }
    }
    
    async function clearCompleted() {
      try {
        const result = await clearCompletedQueue();
        showToast('Cleared ' + (result.cleared || 0) + ' items');
        refresh();
      } catch (err) {
        showToast('Failed to clear: ' + err.message, 'error');
      }
    }
    
    // ========================================================================
    // Main
    // ========================================================================
    
    async function refresh() {
      try {
        const [status, queue, downloads, progress] = await Promise.all([
          fetchStatus(),
          fetchQueue(),
          fetchDownloads(),
          fetchProgress()
        ]);
        
        // Store progress data for use in renderQueue
        currentProgress = {};
        if (progress.items) {
          for (const p of progress.items) {
            currentProgress[p.videoId] = p;
          }
        }
        
        renderStatus(status);
        renderQueue(queue);
        renderDownloads(downloads);
      } catch (err) {
        console.error('Refresh failed:', err);
      }
    }
    
    // Fast progress refresh (every 2 seconds) for active downloads
    let progressInterval;
    
    async function refreshProgress() {
      try {
        const progress = await fetchProgress();
        
        // Update progress data
        currentProgress = {};
        if (progress.items) {
          for (const p of progress.items) {
            currentProgress[p.videoId] = p;
          }
        }
        
        // Re-render queue with updated progress (but don't refetch queue data)
        const queueList = document.getElementById('queue-list');
        if (queueList && Object.keys(currentProgress).length > 0) {
          // Only update progress bars and text, not the whole list
          for (const videoId of Object.keys(currentProgress)) {
            const p = currentProgress[videoId];
            const progressBar = document.querySelector(\`[data-video-id="\${videoId}"] .progress-fill\`);
            const progressText = document.querySelector(\`[data-video-id="\${videoId}"] .progress-text\`);
            if (progressBar) {
              progressBar.style.width = (p.percentage || 0) + '%';
            }
            if (progressText) {
              progressText.textContent = \`\${getPhaseLabel(p.phase)} - \${formatBytes(p.bytesDownloaded)}\${p.totalBytes ? ' / ' + formatBytes(p.totalBytes) : ''}\${p.speed ? ' (' + formatSpeed(p.speed) + ')' : ''}\`;
            }
          }
        }
      } catch (err) {
        // Silently ignore progress refresh errors
      }
    }
    
    function startAutoRefresh() {
      countdown = 5;
      document.getElementById('countdown').textContent = countdown;
      
      // Full refresh every 5 seconds
      refreshInterval = setInterval(() => {
        countdown--;
        document.getElementById('countdown').textContent = countdown;
        
        if (countdown <= 0) {
          refresh();
          countdown = 5;
        }
      }, 1000);
      
      // Fast progress updates every 2 seconds
      progressInterval = setInterval(refreshProgress, 2000);
    }
    
    // Form handler
    document.getElementById('download-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const input = document.getElementById('video-input');
      const videoId = extractVideoId(input.value);
      
      if (!videoId) {
        showToast('Invalid video ID or URL', 'error');
        return;
      }
      
      try {
        const result = await addToQueue(videoId);
        if (result.error) {
          showToast(result.error, 'error');
        } else {
          showToast('Added to queue: ' + videoId);
          input.value = '';
          refresh();
        }
      } catch (err) {
        showToast('Failed to add: ' + err.message, 'error');
      }
    });
    
    // Initial load
    refresh();
    startAutoRefresh();
  </script>
</body>
</html>
`;
