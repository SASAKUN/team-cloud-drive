// Concurrent AJAX upload with progress tracking
// Supports drag-and-drop, file removal, real-time progress bar, speed/ETA

document.addEventListener('DOMContentLoaded', () => {
  const uploadForm = document.getElementById('uploadForm');
  if (!uploadForm) return;

  const fileInput = document.getElementById('files');
  const fileLabel = document.getElementById('fileLabel');
  const selectedDiv = document.getElementById('selectedFiles');
  const dropZone = document.querySelector('.admin-file-input');
  const uploadBtn = document.getElementById('uploadBtn');
  const progressArea = document.getElementById('uploadProgress');

  // Track selected files
  let selectedFiles = new DataTransfer();
  let uploading = false;
  // Track which indices failed in last upload, for retry
  let failedIndices = null;

  // ======== File Input Change ========
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files) {
      selectedFiles.items.add(file);
    }
    failedIndices = null; // reset retry state when new files are added
    resetUploadState();
    renderFileList();
    fileInput.value = '';
  });

  // ======== Drag and Drop ========
  if (dropZone) {
    ['dragenter', 'dragover'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach(evt => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      const allowedExt = /\.(doc|docx|pages|xls|xlsx|numbers|ppt|pptx|key|pdf|txt|csv|md|png|jpg|jpeg|gif|bmp|svg|zip|mp4|mov|avi|mkv)$/i;
      for (const file of files) {
        if (!allowedExt.test(file.name)) {
          alert(`不支持的文件类型: ${file.name}`);
          renderFileList();
          return;
        }
      }
      for (const file of files) {
        selectedFiles.items.add(file);
      }
      failedIndices = null; // reset retry state when new files are added
      resetUploadState();
      renderFileList();
    });
  }

  // ======== Render File List ========
  function renderFileList() {
    const files = selectedFiles.files;
    selectedDiv.innerHTML = '';
    if (files.length === 0) {
      fileLabel.innerHTML = '<span class="upload-icon">＋</span><span>点击选择文件或拖拽文件到此处</span>';
      return;
    }
    fileLabel.innerHTML = `<span class="upload-icon">✓</span><span>已选择 ${files.length} 个文件</span>`;
    let html = '<ul class="selected-list">';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const sizeStr = formatSize(f.size);
      html += `<li>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
        <span class="text-muted" style="white-space:nowrap;">(${sizeStr})</span>
        <button type="button" class="remove-file-btn" data-index="${i}" title="移除">&times;</button>
      </li>`;
    }
    html += '</ul>';
    selectedDiv.innerHTML = html;
    selectedDiv.querySelectorAll('.remove-file-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        removeFileAt(idx);
      });
    });
    // Sync to hidden input
    const dt = new DataTransfer();
    for (const f of selectedFiles.files) dt.items.add(f);
    fileInput.files = dt.files;
  }

  function removeFileAt(index) {
    const newDt = new DataTransfer();
    const files = selectedFiles.files;
    for (let i = 0; i < files.length; i++) {
      if (i !== index) newDt.items.add(files[i]);
    }
    selectedFiles = newDt;
    failedIndices = null; // reset retry state when files are removed
    resetUploadState();
    renderFileList();
  }

  // ======== Upload Engine ========
  const MAX_CONCURRENT = 3;
  const MAX_SIZE = 500 * 1024 * 1024;
  const MAX_COUNT = 20;

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (uploading) return;

    let files = Array.from(selectedFiles.files);

    // If retrying, only send previously failed files
    const isRetry = failedIndices !== null && failedIndices.length > 0;
    if (isRetry) {
      files = files.filter((_, i) => failedIndices.includes(i));
      if (files.length === 0) {
        alert('没有需要重试的文件');
        resetUploadState();
        return;
      }
    }

    if (files.length === 0) {
      alert('请选择要上传的文件');
      return;
    }
    if (files.length > MAX_COUNT) {
      alert(`一次最多上传 ${MAX_COUNT} 个文件，当前选择了 ${files.length} 个`);
      return;
    }
    for (const f of files) {
      if (f.size > MAX_SIZE) {
        alert(`文件 "${f.name}" 过大（${formatSize(f.size)}），单文件最大支持 500MB`);
        return;
      }
    }

    // Get form values
    const description = uploadForm.querySelector('input[name="description"]')?.value || '';
    const visibility = uploadForm.querySelector('select[name="visibility"]')?.value || 'public';

    // Disable form
    uploading = true;
    uploadBtn.textContent = '上传中…';
    uploadBtn.disabled = true;
    fileInput.disabled = true;

    // Show progress area
    if (progressArea) {
      progressArea.style.display = 'block';
      progressArea.innerHTML = buildProgressHTML(files.length, isRetry ? failedIndices : null);
    }

    // Upload files concurrently
    const results = await uploadConcurrently(files, description, visibility, isRetry ? failedIndices : null);
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    if (isRetry) {
      // Retry: remove successfully-retried files from selectedFiles, keep track of still-failed ones
      const newFailed = [];
      let removedFromSelection = new DataTransfer();
      const allFiles = Array.from(selectedFiles.files);

      results.forEach((r, i) => {
        const originalIndex = failedIndices[i];
        if (r.success) {
          // Mark this original index as succeeded — don't include in new selection
          // (we'll skip it when rebuilding)
        } else {
          newFailed.push(originalIndex);
        }
      });

      // Rebuild selectedFiles, excluding files that succeeded on retry
      for (let i = 0; i < allFiles.length; i++) {
        if (failedIndices.includes(i) && results[failedIndices.indexOf(i)]?.success) {
          // This file just succeeded — don't add it back
          continue;
        }
        removedFromSelection.items.add(allFiles[i]);
      }
      selectedFiles = removedFromSelection;
      renderFileList();
      failedIndices = newFailed.length > 0 ? newFailed : null;

      if (newFailed.length === 0) {
        // All retried files succeeded — reload
        setTimeout(() => {
          window.location.reload();
        }, 800);
      } else {
        uploadBtn.textContent = `重试上传（${newFailed.length} 个失败）`;
        uploadBtn.disabled = false;
        fileInput.disabled = false;
        uploading = false;
        updateOverallStatus(`${successCount} 个重试成功，${newFailed.length} 个仍然失败，可继续重试`);
      }
    } else {
      // Fresh upload
      if (failCount === 0) {
        setTimeout(() => {
          window.location.reload();
        }, 800);
      } else {
        // Record which indices failed (from original selectedFiles)
        failedIndices = [];
        results.forEach((r, i) => {
          if (!r.success) failedIndices.push(i);
        });
        uploadBtn.textContent = `重试上传（${failCount} 个失败）`;
        uploadBtn.disabled = false;
        fileInput.disabled = false;
        uploading = false;
        updateOverallStatus(`${successCount} 个成功，${failCount} 个失败，可重试`);
      }
    }
  });

  async function uploadConcurrently(files, description, visibility, indicesOverride) {
    const indices = indicesOverride || files.map((_, i) => i);
    const results = new Array(files.length).fill(null);
    let completed = 0;
    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let uploadedBytes = 0;
    let startTime = Date.now();

    // Start tracking each file
    files.forEach((f, i) => {
      updateFileStatus(i, 'waiting', '等待上传');
    });

    // Create a queue with indices
    const queue = files.map((f, i) => ({ file: f, index: i }));

    // Process queue with concurrency limit
    async function worker() {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;

        updateFileStatus(item.index, 'uploading', '上传中…');

        const result = await uploadSingleFile(item.file, item.index, description, visibility, (loaded) => {
          uploadedBytes += loaded;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = uploadedBytes / elapsed;
          const remaining = totalBytes - uploadedBytes;
          const eta = speed > 0 ? remaining / speed : 0;
          updateOverallProgress(uploadedBytes, totalBytes, speed, eta);
        });

        results[item.index] = result;
        completed++;

        if (result.success) {
          updateFileStatus(item.index, 'done', '完成');
        } else {
          updateFileStatus(item.index, 'error', result.error || '上传失败');
        }
      }
    }

    // Start concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT, files.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  function uploadSingleFile(file, index, description, visibility, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('files', file);
      formData.append('description', description);
      formData.append('visibility', visibility);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          updateFileProgress(index, pct);
          onProgress(e.loaded);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
              resolve({ success: true, data });
            } else {
              resolve({ success: false, error: data.error || '未知错误' });
            }
          } catch {
            resolve({ success: false, error: '服务器返回异常' });
          }
        } else {
          resolve({ success: false, error: `HTTP ${xhr.status}` });
        }
      });

      xhr.addEventListener('error', () => {
        resolve({ success: false, error: '网络错误' });
      });

      xhr.addEventListener('abort', () => {
        resolve({ success: false, error: '已取消' });
      });

      xhr.open('POST', '/admin/upload');
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.send(formData);
    });
  }

  // ======== Progress UI Helpers ========

  function buildProgressHTML(count, indicesOverride) {
    const indices = indicesOverride || Array.from({ length: count }, (_, i) => i);
    let html = '<div class="upload-progress-container">';
    html += '<div class="progress-overall">';
    html += '<div class="progress-bar-track"><div class="progress-bar-fill" id="overallBar"></div></div>';
    html += '<div class="progress-stats">';
    html += '<span id="overallPct">0%</span>';
    html += '<span id="overallSpeed" class="text-muted">—</span>';
    html += '<span id="overallETA" class="text-muted">—</span>';
    html += '</div>';
    html += '<div id="overallStatus" class="progress-status"></div>';
    html += '</div>';
    html += '<div class="progress-files" id="progressFiles">';
    for (let i = 0; i < count; i++) {
      const displayName = selectedFiles.files[indices[i]]?.name || '';
      html += `<div class="progress-file-item" id="fileProgress${i}">
        <span class="progress-file-name" id="fileName${i}">${escapeHtml(displayName)}</span>
        <span class="progress-file-status" id="fileStatus${i}">等待中</span>
        <div class="progress-bar-track file-bar"><div class="progress-bar-fill" id="fileBar${i}" style="width:0%"></div></div>
      </div>`;
    }
    html += '</div></div>';
    return html;
  }

  function updateFileStatus(index, state, text) {
    const nameEl = document.getElementById(`fileName${index}`);
    const statusEl = document.getElementById(`fileStatus${index}`);
    const itemEl = document.getElementById(`fileProgress${index}`);
    if (nameEl && !nameEl.textContent) {
      nameEl.textContent = selectedFiles.files[index]?.name || '';
    }
    if (statusEl) statusEl.textContent = text;
    if (itemEl) {
      itemEl.className = `progress-file-item state-${state}`;
    }
  }

  function updateFileProgress(index, pct) {
    const bar = document.getElementById(`fileBar${index}`);
    if (bar) bar.style.width = pct + '%';
  }

  function updateOverallProgress(uploaded, total, speed, eta) {
    const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
    const bar = document.getElementById('overallBar');
    const pctEl = document.getElementById('overallPct');
    const speedEl = document.getElementById('overallSpeed');
    const etaEl = document.getElementById('overallETA');

    if (bar) bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (speedEl) speedEl.textContent = formatSpeed(speed);
    if (etaEl) etaEl.textContent = formatETA(eta);
  }

  function updateOverallStatus(text) {
    const el = document.getElementById('overallStatus');
    if (el) el.textContent = text;
  }

  function resetUploadState() {
    uploading = false;
    failedIndices = null;
    uploadBtn.textContent = '上传';
    uploadBtn.disabled = false;
    fileInput.disabled = false;
    if (progressArea) progressArea.style.display = 'none';
  }

  // ======== Format Helpers ========
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return Math.round(bytesPerSec) + ' B/s';
    if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  }

  function formatETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return Math.round(seconds) + '秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + '分' + Math.round(seconds % 60) + '秒';
    return Math.floor(seconds / 3600) + '时' + Math.floor((seconds % 3600) / 60) + '分';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Initial render
  renderFileList();
});
