// Client-side upload: drag-and-drop, file removal, validation
document.addEventListener('DOMContentLoaded', () => {
  const uploadForm = document.getElementById('uploadForm');
  if (!uploadForm) return;

  const fileInput = document.getElementById('files');
  const fileLabel = document.getElementById('fileLabel');
  const selectedDiv = document.getElementById('selectedFiles');
  const dropZone = document.querySelector('.admin-file-input');

  // Track selected files in a DataTransfer-like structure
  let selectedFiles = new DataTransfer();

  // ======== File Input Change ========
  fileInput.addEventListener('change', () => {
    for (const file of fileInput.files) {
      selectedFiles.items.add(file);
    }
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

      // Validate types & size
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
      const sizeMB = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : (f.size / 1024).toFixed(1) + ' KB';
      html += `<li>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.name)}</span>
        <span class="text-muted" style="white-space:nowrap;">(${sizeMB})</span>
        <button type="button" class="remove-file-btn" data-index="${i}" title="移除">&times;</button>
      </li>`;
    }
    html += '</ul>';
    selectedDiv.innerHTML = html;

    // Bind remove buttons
    selectedDiv.querySelectorAll('.remove-file-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        removeFileAt(idx);
      });
    });

    // Sync to hidden file input for form submission
    const dt = new DataTransfer();
    for (const f of selectedFiles.files) {
      dt.items.add(f);
    }
    fileInput.files = dt.files;
  }

  function removeFileAt(index) {
    const newDt = new DataTransfer();
    const files = selectedFiles.files;
    for (let i = 0; i < files.length; i++) {
      if (i !== index) newDt.items.add(files[i]);
    }
    selectedFiles = newDt;
    renderFileList();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ======== Form Submit ========
  uploadForm.addEventListener('submit', (e) => {
    if (selectedFiles.files.length === 0) {
      e.preventDefault();
      alert('请选择要上传的文件');
      return;
    }

    const maxSize = 500 * 1024 * 1024; // 500MB per file
    const maxCount = 20;
    const files = selectedFiles.files;

    if (files.length > maxCount) {
      e.preventDefault();
      alert(`一次最多上传 ${maxCount} 个文件，当前选择了 ${files.length} 个`);
      return;
    }

    for (let i = 0; i < files.length; i++) {
      if (files[i].size > maxSize) {
        e.preventDefault();
        alert(`文件 "${files[i].name}" 过大（${(files[i].size / 1024 / 1024).toFixed(1)}MB），单文件最大支持 500MB`);
        return;
      }
    }

    const btn = uploadForm.querySelector('button[type="submit"]');
    btn.textContent = '上传中…';
    btn.disabled = true;
  });

  // Initial render
  renderFileList();
});
