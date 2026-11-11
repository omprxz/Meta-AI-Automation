function isAllowedMetaAiUrl() {
  try {
    const u = new URL(window.location.href);
    const h = u.hostname.toLowerCase();
    return h === "meta.ai" || h.endsWith(".meta.ai");
  } catch (err) {
    return false;
  }
}

// Track client-side SPA route changes on Meta AI and notify background
let lastPath = window.location.pathname;
function checkSpaNavigation() {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    try {
      chrome.runtime.sendMessage({
        action: "TAB_URL_CHANGED",
        url: window.location.href,
      });
    } catch (e) {}
  }
}
setInterval(checkSpaNavigation, 800);
window.addEventListener("popstate", checkSpaNavigation);

if (!isAllowedMetaAiUrl()) {
  console.log("[Meta AI Automator] Inactive: Page is outside https://meta.ai.");
} else {
  console.log("[Meta AI Automator] Active on Meta.ai route.");

  let isKilled = false;
  let isAutomationActive = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findChatBox() {
    const candidates = Array.from(
      document.querySelectorAll(
        'div[contenteditable="true"][role="textbox"], ' +
        'div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"], ' +
        'textarea, ' +
        '[role="textbox"]'
      )
    );

    const visible = candidates.filter((el) => {
      if (el.getAttribute("aria-hidden") === "true") return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 30 &&
        rect.height > 15
      );
    });

    if (visible.length > 0) {
      // Sort descending by vertical position so the main prompt box towards bottom is preferred
      visible.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

      // Prefer element inside a form
      const inForm = visible.find((el) => el.closest("form"));
      if (inForm) return inForm;

      // Prefer contenteditable with role="textbox"
      const withRole = visible.find(
        (el) => el.getAttribute("contenteditable") === "true" && el.getAttribute("role") === "textbox"
      );
      if (withRole) return withRole;

      // Prefer contenteditable
      const editable = visible.find((el) => el.getAttribute("contenteditable") === "true");
      if (editable) return editable;

      return visible[0];
    }

    return (
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('textarea') ||
      document.querySelector('[role="textbox"]')
    );
  }

  function findFileInput() {
    let input = (
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]')
    );
    if (!input) {
      // Try to find and click the attach/media button to reveal the file input
      const attachBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.getAttribute("title") || "").toLowerCase();
        return (
          aria.includes("attach") ||
          aria.includes("add media") ||
          aria.includes("add photo") ||
          aria.includes("upload") ||
          title.includes("attach") ||
          title.includes("upload")
        );
      });
      if (attachBtn) {
        attachBtn.click();
        input = (
          document.querySelector('input[type="file"][accept*="image"]') ||
          document.querySelector('input[type="file"]')
        );
      }
    }
    return input;
  }

  function findSendButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return (
      buttons.find((btn) => {
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        const title = (btn.getAttribute("title") || "").toLowerCase();
        const text = (btn.textContent || "").trim().toLowerCase();
        return (
          aria.includes("send") ||
          aria.includes("generate") ||
          aria.includes("submit") ||
          title.includes("send") ||
          title.includes("generate") ||
          text === "send" ||
          text === "generate"
        );
      }) || document.querySelector('button[type="submit"]')
    );
  }

  // Stage 1 & 2: Upload and verify image attachment
  async function uploadAndVerifyImage(imageSrc, imageName, timeoutMs = 30000) {
    console.log("[Meta AI Automator] [Stage 1/4] Preparing image upload...");
    const fileInput = findFileInput();
    if (!fileInput) throw new Error("Meta AI file input not found on page.");

    const resp = await fetch(imageSrc);
    const blob = await resp.blob();
    const file = new File([blob], imageName || "upload.jpg", {
      type: blob.type || "image/jpeg",
    });

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    console.log("[Meta AI Automator] File dispatched to input. Waiting for attachment confirmation in DOM...");

    const start = Date.now();
    let attached = false;

    while (Date.now() - start < timeoutMs) {
      if (isKilled) throw new Error("Automation interrupted by user.");

      // Check for attachment thumbnail, remove button, or preview container in DOM
      const removeBtn = document.querySelector(
        'button[aria-label*="Remove" i], button[aria-label*="Delete" i], button[aria-label*="Cancel" i], [data-testid*="attachment-remove"], [data-testid*="media-preview"]'
      );
      const previewImg = document.querySelector(
        'div[role="textbox"] ~ * img, form img, div[contenteditable="true"] ~ * img, div[data-testid*="preview"] img, [aria-label*="Attachment" i]'
      );

      if (removeBtn || previewImg) {
        attached = true;
        console.log("[Meta AI Automator] ✅ [Stage 1/4] Image attachment verified in DOM.");
        break;
      }
      await sleep(300);
    }

    if (!attached) {
      console.warn("[Meta AI Automator] Attachment badge not explicitly found within timeout, verifying input files...");
      if (!fileInput.files || fileInput.files.length === 0) {
        throw new Error("Meta AI image upload failed: attachment was rejected or not processed.");
      }
    }

    await sleep(1500); // Allow Meta.ai internal React state to settle
    return true;
  }

  // Stage 3: Inject and verify prompt text in chat box / contenteditable
  async function injectAndVerifyPrompt(promptText) {
    console.log(`[Meta AI Automator] [Stage 2/4] Injecting prompt: "${promptText.substring(0, 35)}..."`);
    const chatBox = findChatBox();
    if (!chatBox) throw new Error("Meta AI prompt input box not found.");

    chatBox.scrollIntoView({ behavior: "smooth", block: "center" });
    chatBox.click();
    chatBox.focus();
    await sleep(250);

    const isInputOrTextarea = chatBox.tagName === "TEXTAREA" || chatBox.tagName === "INPUT";

    if (isInputOrTextarea) {
      const proto = chatBox.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(chatBox, promptText);
      } else {
        chatBox.value = promptText;
      }
      chatBox.dispatchEvent(new Event("input", { bubbles: true }));
      chatBox.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Contenteditable (Lexical / Draft.js / ProseMirror)
      // 1. Establish Range Selection
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(chatBox);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}

      // 2. Clear existing text
      try {
        document.execCommand("delete", false, null);
      } catch (e) {}

      // 3. Dispatch beforeinput (Lexical native input listener)
      try {
        const beforeInput = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: promptText,
        });
        chatBox.dispatchEvent(beforeInput);
      } catch (e) {}

      // 4. Try execCommand insertText
      let execOk = false;
      try {
        execOk = document.execCommand("insertText", false, promptText);
      } catch (e) {}

      // 5. Simulate clipboard paste event (universal across rich-text editors)
      let currentCheck = (chatBox.innerText || chatBox.textContent || "").trim();
      if (!execOk || !currentCheck.includes(promptText.slice(0, 10))) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", promptText);
          const pasteEvent = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          });
          chatBox.dispatchEvent(pasteEvent);
        } catch (e) {}
      }

      // 6. Direct Lexical DOM structure fallback
      await sleep(150);
      currentCheck = (chatBox.innerText || chatBox.textContent || "").trim();
      if (!currentCheck.includes(promptText.slice(0, 10))) {
        let p = chatBox.querySelector("p");
        if (!p) {
          p = document.createElement("p");
          p.setAttribute("dir", "ltr");
          chatBox.appendChild(p);
        }
        let span = p.querySelector('span[data-lexical-text="true"]') || p.querySelector("span");
        if (!span) {
          span = document.createElement("span");
          span.setAttribute("data-lexical-text", "true");
          p.appendChild(span);
        }
        span.textContent = promptText;

        chatBox.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: promptText,
          })
        );
        chatBox.dispatchEvent(new Event("input", { bubbles: true }));
        chatBox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Verify prompt in DOM with retry polling (up to 3 seconds)
    const startVerify = Date.now();
    let verifiedText = "";

    while (Date.now() - startVerify < 3000) {
      verifiedText = (
        chatBox.value ||
        chatBox.innerText ||
        chatBox.textContent ||
        chatBox.querySelector('span[data-lexical-text="true"]')?.textContent ||
        ""
      ).trim();

      if (verifiedText.length > 0) {
        break;
      }
      await sleep(200);
    }

    if (!verifiedText) {
      // Last-ditch: force textContent directly and proceed
      chatBox.textContent = promptText;
      chatBox.dispatchEvent(new Event("input", { bubbles: true }));
      verifiedText = (chatBox.textContent || "").trim();
      if (!verifiedText) {
        throw new Error("Failed to populate Custom Prompt field in Meta AI chat box.");
      }
    }

    console.log(`[Meta AI Automator] ✅ [Stage 2/4] Prompt verified in DOM ("${verifiedText.substring(0, 30)}...").`);
    await sleep(500);
    return true;
  }

  // Trigger send / generate
  async function triggerSend() {
    const chatBox = findChatBox();
    const sendBtn = findSendButton();

    if (sendBtn && !sendBtn.disabled && sendBtn.getBoundingClientRect().width > 0) {
      sendBtn.click();
      console.log("[Meta AI Automator] Clicked Send button.");
    } else if (chatBox) {
      chatBox.focus();
      const enterDown = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      });
      chatBox.dispatchEvent(enterDown);
      const enterPress = new KeyboardEvent("keypress", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      });
      chatBox.dispatchEvent(enterPress);
      const enterUp = new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      });
      chatBox.dispatchEvent(enterUp);
      console.log("[Meta AI Automator] Dispatched Enter key events.");
    } else {
      throw new Error("Could not find Send button or prompt box to trigger generation.");
    }
    await sleep(1000);
  }

  // Stage 4: Wait for generation and extract verified video/image URL
  async function waitForGenerationCompletion(mode, timeoutMs = 180000) {
    console.log(`[Meta AI Automator] [Stage 3/4] Awaiting ${mode} generation completion...`);
    const start = Date.now();
    let animateClicked = false;

    while (Date.now() - start < timeoutMs) {
      if (isKilled) throw new Error("Automation interrupted by user.");

      // In Video or Img-to-Video mode, handle Animate buttons if present
      if (mode !== "Image" && !animateClicked) {
        const animateButtons = Array.from(
          document.querySelectorAll(
            'button:not([data-automator-clicked="true"]), [role="button"]:not([data-automator-clicked="true"])'
          )
        ).filter((btn) => {
          const text = (btn.textContent || "").toLowerCase();
          const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
          return (text.includes("animate") || aria.includes("animate")) && btn.getBoundingClientRect().height > 0;
        });

        if (animateButtons.length > 0) {
          const targetBtn = animateButtons[0];
          targetBtn.setAttribute("data-automator-clicked", "true");
          targetBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
          await sleep(600);
          targetBtn.click();
          animateClicked = true;
          console.log("[Meta AI Automator] ✅ Clicked Animate button. Video rendering in progress...");
        }
      }

      // Check for video generation completion
      if (mode === "Video" || mode === "Img-to-Video") {
        const videoElements = Array.from(
          document.querySelectorAll('div[data-testid="generated-video"] video, video')
        ).filter((v) => {
          const src = v.currentSrc || v.src || "";
          return src.startsWith("http") || src.startsWith("blob:");
        });

        for (const vid of videoElements) {
          const src = vid.currentSrc || vid.src;
          if (!sessionStorage.getItem("processed_" + src)) {
            // Verify video media state is loaded and ready
            if (vid.readyState >= 2 || vid.duration > 0 || (vid.videoWidth && vid.videoWidth > 0)) {
              // Ensure no active loading spinner or progress overlay is animating on this video
              const container = vid.closest('div[data-testid="generated-video"]') || vid.parentElement;
              const hasLoading = container?.querySelector('[role="progressbar"], .animate-spin, [data-testid*="loading"]');
              if (!hasLoading) {
                sessionStorage.setItem("processed_" + src, "true");
                console.log("[Meta AI Automator] ✅ [Stage 3/4] Video generation verified complete:", src);
                return {
                  url: src,
                  type: "video",
                };
              }
            }
          }
        }
      } else {
        // Image mode
        const imageElements = Array.from(
          document.querySelectorAll('img[data-testid="generated-image"], img[src*="fbcdn"]')
        ).filter((img) => {
          const src = img.currentSrc || img.src || "";
          return src.startsWith("http") && !src.includes("icon") && !src.includes("profile");
        });

        for (const img of imageElements) {
          const src = img.currentSrc || img.src;
          if (!sessionStorage.getItem("processed_" + src)) {
            if (img.complete && img.naturalWidth > 100) {
              sessionStorage.setItem("processed_" + src, "true");
              console.log("[Meta AI Automator] ✅ [Stage 3/4] Image generation verified complete:", src);
              return {
                url: src,
                type: "image",
              };
            }
          }
        }
      }

      await sleep(1000);
    }

    throw new Error(`${mode} generation timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  // Message Listener
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "FORCE_KILL") {
      isKilled = true;
      isAutomationActive = false;
      console.warn("💀 Force kill received. Stopping worker.");
      sendResponse({ status: "killed" });
      return;
    }

    if (request.action === "CLEAR_CACHE") {
      sessionStorage.clear();
      isKilled = false;
      isAutomationActive = false;
      console.log("🧹 Session Cache & Locks Cleared.");
      sendResponse({ status: "cleared" });
      return;
    }

    if (request.action === "EXECUTE_PROMPT") {
      isKilled = false;
      isAutomationActive = true;
      console.log("🔥 [Meta AI Automator] Executing item ->", request.promptText.substring(0, 35) + "...");

      (async () => {
        try {
          // 1. Stamp old buttons so we don't re-click old Animate buttons
          document
            .querySelectorAll(
              'button:not([data-automator-clicked="true"]), [role="button"]:not([data-automator-clicked="true"])'
            )
            .forEach((btn) => {
              const text = btn.textContent?.toLowerCase() || "";
              const aria = btn.getAttribute("aria-label")?.toLowerCase() || "";
              if (text.includes("animate") || aria.includes("animate")) {
                btn.setAttribute("data-automator-clicked", "true");
              }
            });

          // 2. Upload image if in Img-to-Video mode
          if (request.mode === "Img-to-Video" && request.image) {
            await uploadAndVerifyImage(request.image, request.imageName);
          }

          if (isKilled) throw new Error("Automation interrupted by user.");

          // 3. Inject and verify prompt text in input field
          const effectivePrompt = (request.promptText && request.promptText.trim())
            ? request.promptText.trim()
            : request.mode === "Img-to-Video"
              ? "Animate this"
              : "";

          if (effectivePrompt) {
            await injectAndVerifyPrompt(effectivePrompt);
          }

          if (isKilled) throw new Error("Automation interrupted by user.");

          // 4. Trigger Send / Generate
          await triggerSend();

          if (isKilled) throw new Error("Automation interrupted by user.");

          // 5. Wait for generation completion and extract verified media URL
          const mediaResult = await waitForGenerationCompletion(request.mode);

          if (isKilled) throw new Error("Automation interrupted by user.");

          console.log("✅ [Meta AI Automator] Item fully generated. Returning media info for verified download.");
          sendResponse({
            status: "success",
            mediaUrl: mediaResult.url,
            type: mediaResult.type,
          });
        } catch (err) {
          console.error("❌ [Meta AI Automator] Execution Error:", err);
          sendResponse({
            status: "error",
            message: err.message || "Unknown error during Meta AI generation.",
          });
        }
      })();

      return true; // Keep channel open for async sendResponse
    }
  });
}
