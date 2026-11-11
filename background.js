// Background Service Worker for Meta AI Automator

function isAllowedMetaAiUrl(urlStr) {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    return h === "meta.ai" || h.endsWith(".meta.ai");
  } catch {
    return false;
  }
}

// Enable and auto-open side panel on all meta.ai tabs
async function updateSidePanelTab(tabId, url) {
  if (!tabId || !url) return;
  const isAllowed = isAllowedMetaAiUrl(url);
  try {
    if (isAllowed) {
      await chrome.sidePanel.setOptions({
        tabId: tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      // Attempt to auto-open side panel on meta.ai routes
      await chrome.sidePanel.open({ tabId: tabId }).catch(() => {
        // Handled cleanly if browser restricts open to user gesture
      });
    } else {
      // Disable side panel on websites outside meta.ai
      await chrome.sidePanel.setOptions({
        tabId: tabId,
        enabled: false,
      });
    }
  } catch (err) {}
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error(e));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (url) {
    updateSidePanelTab(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) {
      updateSidePanelTab(activeInfo.tabId, tab.url);
    }
  } catch (err) {}
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url) {
        updateSidePanelTab(tab.id, tab.url);
      }
    }
  } catch (err) {}
});

// IndexedDB Helper for Large Payload Support (Bypasses 64MiB IPC Limit)
const DB_NAME = "MetaAI_Automator_DB";
const STORE_NAME = "queue";

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "index" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getQueueItemFromDB(index) {
  const db = await openQueueDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(index);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearQueueDB() {
  try {
    const db = await openQueueDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// Execution State
var isRunning = false,
  isPaused = false,
  isStopped = false,
  queue = [],
  currentIndex = 0,
  totalItems = 0,
  useDB = false,
  downloadCount = 0,
  config = {},
  countdownTimer = null;

function broadcast(action, payload) {
  try {
    chrome.runtime.sendMessage({ action: action, payload: payload });
  } catch (e) {}
}

// Download verifier: waits for download to reach state 'complete' on disk
function triggerAndVerifyDownload(url, folder, filename, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const fullPath = `${folder}/${filename}`;
    broadcast("LOG_UPDATE", `📥 Initiating download: ${filename}...`);

    chrome.downloads.download(
      {
        url: url,
        filename: fullPath,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(chrome.runtime.lastError?.message || "Failed to initiate download."));
          return;
        }

        console.log(`[Meta AI Automator] Download #${downloadId} started for ${fullPath}. Verifying completion on disk...`);
        broadcast("LOG_UPDATE", `⏳ Verifying download on disk for ${filename}...`);

        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChangedListener);
          reject(new Error(`Download for ${filename} timed out after ${timeoutMs / 1000}s.`));
        }, timeoutMs);

        function onChangedListener(delta) {
          if (delta.id === downloadId) {
            if (delta.state?.current === "complete") {
              clearTimeout(timer);
              chrome.downloads.onChanged.removeListener(onChangedListener);
              broadcast("LOG_UPDATE", `✅ Download verified on disk: ${filename}`);
              resolve(downloadId);
            } else if (delta.state?.current === "interrupted") {
              clearTimeout(timer);
              chrome.downloads.onChanged.removeListener(onChangedListener);
              reject(new Error(`Download interrupted: ${delta.error?.current || "Network error"}`));
            }
          }
        }

        chrome.downloads.onChanged.addListener(onChangedListener);

        // Check if already completed (e.g. from local memory cache)
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (items && items[0]?.state === "complete") {
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(onChangedListener);
            broadcast("LOG_UPDATE", `✅ Download verified on disk: ${filename}`);
            resolve(downloadId);
          }
        });
      }
    );
  });
}

// Message Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "TAB_URL_CHANGED" && sender.tab?.id) {
    updateSidePanelTab(sender.tab.id, msg.url);
    sendResponse({ status: "acknowledged" });
    return;
  }

  if (msg.action === "START_AUTOMATION") {
    config = {
      baseInterval: msg.payload.baseInterval || 60,
      randomRange: msg.payload.randomRange || 10,
      autoDownload: msg.payload.autoDownload !== false,
      downloadFolder: msg.payload.downloadFolder || "Meta_AI_I2V",
      generationMode: msg.payload.generationMode || "Img-to-Video",
    };

    if (msg.payload.useDB) {
      useDB = true;
      totalItems = msg.payload.totalCount || 0;
      currentIndex = 0;
      queue = [];
    } else {
      useDB = false;
      queue = msg.payload.prompts || [];
      totalItems = queue.length;
      currentIndex = 0;
    }

    isRunning = true;
    isPaused = false;
    isStopped = false;
    downloadCount = 0;

    (async () => {
      runWorkflowLoop();
    })();

    sendResponse({ status: "started" });
  } else if (msg.action === "PAUSE_AUTOMATION") {
    isPaused = true;
    countdownTimer && clearTimeout(countdownTimer);
    broadcast("LOG_UPDATE", `⏸️ Automation Paused at item ${currentIndex + 1}/${totalItems}.`);
    broadcast("STATUS_UPDATE", { status: "paused", currentIndex, totalItems });
    sendResponse({ status: "paused" });
  } else if (msg.action === "RESUME_AUTOMATION") {
    if (isPaused) {
      isPaused = false;
      isRunning = true;
      isStopped = false;
      broadcast("LOG_UPDATE", `▶️ Resuming automation from item ${currentIndex + 1}/${totalItems}...`);
      broadcast("STATUS_UPDATE", { status: "running", currentIndex, totalItems });
      (async () => {
        runWorkflowLoop();
      })();
    }
    sendResponse({ status: "resumed" });
  } else if (msg.action === "STOP_AUTOMATION") {
    isStopped = true;
    isRunning = false;
    isPaused = false;
    countdownTimer && clearTimeout(countdownTimer);
    clearQueueDB();
    queue = [];
    currentIndex = 0;

    // Send force kill to active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "FORCE_KILL" }).catch(() => {});
      }
    });

    broadcast("PROGRESS_UPDATE", { completed: 0, total: totalItems });
    broadcast("STATUS_UPDATE", { status: "idle", currentIndex: 0, totalItems });
    broadcast("LOG_UPDATE", "STOP: Automation Terminated.");
    sendResponse({ status: "stopped" });
  } else if (msg.action === "CLEAR_CACHE") {
    isStopped = true;
    isRunning = false;
    isPaused = false;
    countdownTimer && clearTimeout(countdownTimer);
    clearQueueDB();
    queue = [];
    currentIndex = 0;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "CLEAR_CACHE" }).catch(() => {});
      }
    });

    sendResponse({ status: "cleared" });
  }
});

// Master Automation Loop
async function runWorkflowLoop() {
  if (!isRunning || isStopped) {
    isRunning = false;
    broadcast("AUTOMATION_FINISHED");
    clearQueueDB();
    return;
  }

  if (isPaused) {
    console.log("[Meta AI Automator] Automation paused. Awaiting resume...");
    return;
  }

  // Check completion
  const isFinished = useDB ? currentIndex >= totalItems : queue.length === 0;
  if (isFinished) {
    isRunning = false;
    broadcast("PROGRESS_UPDATE", { completed: totalItems, total: totalItems });
    broadcast("LOG_UPDATE", "🎉 All items generated and verified successfully!");
    broadcast("AUTOMATION_FINISHED");
    clearQueueDB();
    return;
  }

  const currentStep = currentIndex + 1;
  broadcast("PROGRESS_UPDATE", { completed: currentStep, total: totalItems });

  let item = null;
  if (useDB) {
    item = await getQueueItemFromDB(currentIndex);
  } else {
    item = queue[0];
  }

  const promptText = (item?.prompt && item.prompt.trim())
    ? item.prompt.trim()
    : config.generationMode === "Img-to-Video"
      ? "Animate this"
      : "";
  const mediaImage = item?.image || null;
  const imageName = item?.name || `Item_${String(currentStep).padStart(3, "0")}`;

  broadcast(
    "LOG_UPDATE",
    `▶️ [${currentStep}/${totalItems}] Processing: ${imageName} -> "${promptText.split(/\s+/).slice(0, 4).join(" ")}..."`
  );

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      throw new Error("No active browser tab found.");
    }

    const activeTab = tabs[0];
    if (!isAllowedMetaAiUrl(activeTab.url)) {
      broadcast("LOG_UPDATE", "❌ ERROR: Tab navigated outside meta.ai. Automation halted.");
      isRunning = false;
      broadcast("AUTOMATION_FINISHED");
      clearQueueDB();
      return;
    }

    // Set zoom for reliable element positioning
    chrome.tabs.setZoom(activeTab.id, 0.60).catch(() => {});

    // Step 1: Execute Prompt in content.js and wait for generation completion
    const executionPromise = new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        activeTab.id,
        {
          action: "EXECUTE_PROMPT",
          promptText: promptText,
          image: mediaImage,
          imageName: imageName,
          mode: config.generationMode,
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error("Lost connection to Meta AI page. Please refresh the page!"));
            return;
          }
          if (res && res.status === "error") {
            reject(new Error(res.message || "Meta AI generation error."));
            return;
          }
          if (!res || !res.mediaUrl) {
            reject(new Error("No generated media URL returned from Meta AI."));
            return;
          }
          resolve(res);
        }
      );
    });

    const execResult = await executionPromise;

    if (!isRunning || isStopped || isPaused) return;

    // Step 2: Download and verify generated media on disk before advancing
    if (config.autoDownload && execResult.mediaUrl) {
      downloadCount++;
      const fileExt = execResult.type === "video" ? "mp4" : "jpg";
      const filePrefix = execResult.type === "video" ? "Vid" : "Img";
      const fileName = `${filePrefix}_${String(downloadCount).padStart(3, "0")}.${fileExt}`;

      await triggerAndVerifyDownload(
        execResult.mediaUrl,
        config.downloadFolder,
        fileName
      );
    }

    if (!isRunning || isStopped || isPaused) return;

    // Step 3: Advance index ONLY AFTER generation and download are verified
    currentIndex++;
    if (!useDB) queue.shift();

    const isLastItem = useDB ? currentIndex >= totalItems : queue.length === 0;

    if (isLastItem) {
      isRunning = false;
      broadcast("PROGRESS_UPDATE", { completed: totalItems, total: totalItems });
      broadcast("LOG_UPDATE", "🎉 Complete automated workflow finished! All media verified.");
      broadcast("AUTOMATION_FINISHED");
      clearQueueDB();
      return;
    }

    // Interval countdown before next item
    const intervalSec = Math.round(
      config.baseInterval + (Math.random() - 0.5) * 2 * config.randomRange
    );

    for (let sec = intervalSec; sec >= 0; sec--) {
      if (!isRunning || isStopped || isPaused) return;
      broadcast("COUNTDOWN_UPDATE", {
        message: `${Math.floor(sec / 60).toString().padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`,
        isLast: false,
      });
      if (sec > 0) {
        await new Promise((res) => {
          countdownTimer = setTimeout(res, 1000);
        });
      }
    }
    broadcast("COUNTDOWN_UPDATE", { message: "", isLast: false });

    // Loop to next item
    runWorkflowLoop();
  } catch (err) {
    console.error("[Meta AI Automator] Loop Error:", err);
    broadcast("LOG_UPDATE", `❌ ERROR: ${err.message}`);
    isRunning = false;
    broadcast("STATUS_UPDATE", { status: "idle", currentIndex, totalItems });
  }
}
