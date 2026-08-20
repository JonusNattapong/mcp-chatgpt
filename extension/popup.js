document.addEventListener('DOMContentLoaded', () => {
  const statusBadge = document.getElementById('statusBadge');
  const profileInput = document.getElementById('profileName');
  const saveBtn = document.getElementById('saveBtn');
  const openTabBtn = document.getElementById('openTabBtn');

  // Request status from background worker
  chrome.runtime.sendMessage({ action: 'get_status' }, (res) => {
    if (res) {
      updateStatusUI(res.connected);
      if (res.profileName) {
        profileInput.value = res.profileName;
      }
    }
  });

  function updateStatusUI(connected) {
    if (connected) {
      statusBadge.textContent = 'Connected (Bridge Active)';
      statusBadge.className = 'status-badge status-connected';
    } else {
      statusBadge.textContent = 'Disconnected';
      statusBadge.className = 'status-badge status-disconnected';
    }
  }

  saveBtn.addEventListener('click', () => {
    const profileName = profileInput.value.trim() || 'Chrome Extension Profile';
    chrome.runtime.sendMessage({ action: 'reconnect', profileName }, (res) => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'get_status' }, (statusRes) => {
          if (statusRes) updateStatusUI(statusRes.connected);
        });
      }, 500);
    });
  });

  openTabBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com' });
  });
});
