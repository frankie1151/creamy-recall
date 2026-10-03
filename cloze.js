"use strict";

(() => {
  if (window.CreamyCloze) return;

  const MARK = "span[data-cloze-id]";
  const STUDY_IDS = [
    "studyQuestion",
    "studyAnswer",
    "studyQuestionSplit",
    "studyAnswerSplit"
  ];

  const EDITOR_SELECTOR = [
    "#questionEditor",
    "#answerEditor",
    ...STUDY_IDS.map(id => `#${id}`)
  ].join(",");

  const BLOCK_SELECTOR = "p, div, li, td, th, blockquote";

  let savedSelection = null;
  let gesture = null;
  let holdTimer = null;

  let session = null;
  let currentNoteId = "";
  const revealed = new Set();

  let menuRoot = null;
  let menuNoteId = "";

  const byId = id => document.getElementById(id);

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement;
  }

  function closest(node, selector) {
    return elementOf(node)?.closest(selector) || null;
  }

  function currentNote() {
    if (typeof studyState === "undefined" || !studyState?.active) {
      return null;
    }
    return studyState.notes?.[studyState.index] || null;
  }

  function toast(title, body = "") {
    if (typeof showToast === "function") {
      showToast(title, body, "info");
    }
  }

  function studyRoots() {
    return STUDY_IDS.map(byId).filter(Boolean);
  }

  function sideOf(root) {
    return /Question/.test(root.id) ? "question" : "answer";
  }

  function keyFor(root, marker) {
    return `${sideOf(root)}:${marker.dataset.clozeId}`;
  }

  function editorOwner(editor) {
    if (!editor?.isConnected || !editor.isContentEditable) {
      return "";
    }

    if (editor.id === "questionEditor" || editor.id === "answerEditor") {
      const modal = byId("noteModal");
      if (!modal || modal.classList.contains("hidden")) return "";
      return `modal:${byId("noteId")?.value || "new"}`;
    }

    if (
      STUDY_IDS.includes(editor.id) &&
      typeof studyInlineEditing !== "undefined" &&
      studyInlineEditing &&
      currentNote()
    ) {
      return `study:${currentNote().id}`;
    }

    return "";
  }

  /* ---------- 選取範圍 ---------- */

  function rememberSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;

    const range = selection.getRangeAt(0);
    const editor = closest(range.commonAncestorContainer, EDITOR_SELECTOR);
    const owner = editorOwner(editor);

    if (!owner) return;
    if (!editor.contains(range.startContainer)) return;
    if (!editor.contains(range.endContainer)) return;

    savedSelection = {
      editor,
      owner,
      range: range.cloneRange()
    };
  }

  function getSavedRange(editor) {
    const saved = savedSelection;

    if (
      !saved ||
      saved.editor !== editor ||
      saved.owner !== editorOwner(editor) ||
      !editor.contains(saved.range.startContainer) ||
      !editor.contains(saved.range.endContainer)
    ) {
      return null;
    }

    return saved.range.cloneRange();
  }

  function restoreRange(editor, range) {
    editor.focus({ preventScroll: true });

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function syncDraft(editor) {
    /*
      只更新學習編輯草稿。
      不 dispatch input，避免觸發舊 G1 的 DOM → note 寫入。
      不直接修改 appState、不自動儲存。
    */
    if (
      STUDY_IDS.includes(editor.id) &&
      typeof studyInlineEditing !== "undefined" &&
      studyInlineEditing
    ) {
      const targets = getStudyEditableTargets();
      studyEditDraft.questionHtml = getEditorHtml(targets.question);
      studyEditDraft.answerHtml = getEditorHtml(targets.answer);
    }

    rememberSelection();
  }

  function selectedTextParts(editor, range) {
    const parts = [];
    const walker = document.createTreeWalker(
      editor,
      NodeFilter.SHOW_TEXT
    );

    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;

      const start = node === range.startContainer
        ? range.startOffset
        : 0;

      const end = node === range.endContainer
        ? range.endOffset
        : node.length;

      if (end > start) parts.push({ node, start, end });
    }

    return parts;
  }

  function unwrapMarker(marker) {
    marker.replaceWith(...Array.from(marker.childNodes));
  }

  function toggleMark(editor) {
    if (!editorOwner(editor)) {
      toast("請先進入編輯模式");
      return;
    }

    const range = getSavedRange(editor);

    if (!range) {
      toast("請先選取文字", "選取內容後再按「填空」。");
      return;
    }

    restoreRange(editor, range);

    const startMark = closest(range.startContainer, MARK);
    const endMark = closest(range.endContainer, MARK);

    /*
      游標在填空中，或選取同一組填空：
      取消整組標記，但不刪文字。
    */
    if (
      startMark &&
      editor.contains(startMark) &&
      (range.collapsed ||
        endMark?.dataset.clozeId === startMark.dataset.clozeId)
    ) {
      const id = startMark.dataset.clozeId;

      const markers = [...editor.querySelectorAll(MARK)]
        .filter(marker => marker.dataset.clozeId === id);

      markers.forEach(unwrapMarker);

      syncDraft(editor);
      toast("已取消填空", "請按原本的儲存按鈕保存。");
      return;
    }

    if (range.collapsed || !range.toString().trim()) {
      toast("請先選取文字");
      return;
    }

    const fragment = range.cloneContents();

    /*
      第一版不允許跨段、跨格、圖片或連結混合選取。
      粗體、斜體、顏色可保留。
    */
    if (
      fragment.querySelector(
        "p, div, ul, ol, li, table, tr, td, th, " +
        "blockquote, img, a, br, [contenteditable='false']"
      )
    ) {
      toast("請在同一段文字內建立填空", "多個清單項目請分開標記。");
      return;
    }

    const parts = selectedTextParts(editor, range);

    if (!parts.length) return;

    const block = closest(parts[0].node, BLOCK_SELECTOR);

    const invalid = parts.some(part => {
      return (
        closest(part.node, BLOCK_SELECTOR) !== block ||
        closest(
          part.node,
          `${MARK}, a, [contenteditable='false'], [data-missed-point-id]`
        )
      );
    });

    if (invalid) {
      toast(
        "這個選取範圍暫不支援",
        "請勿跨段，或與現有填空／常漏點重疊。"
      );
      return;
    }

    const id = typeof uid === "function"
      ? uid("cloze")
      : `cloze-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let lastMarker = null;

    /*
      從尾到頭處理文字節點。
      不搬動 p / li / td，也不破壞原有格式標籤。
      同一次選取的不同文字片段使用同一 ID。
    */
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const { node, start, end } = parts[index];

      if (end < node.length) node.splitText(end);

      const selectedNode = start > 0
        ? node.splitText(start)
        : node;

      const marker = document.createElement("span");
      marker.dataset.clozeId = id;

      selectedNode.replaceWith(marker);
      marker.appendChild(selectedNode);

      if (index === parts.length - 1) lastMarker = marker;
    }

    if (lastMarker) {
      const caret = document.createRange();
      caret.setStartAfter(lastMarker);
      caret.collapse(true);
      restoreRange(editor, caret);
    }

    syncDraft(editor);
    toast("已建立填空", "請按原本的儲存按鈕保存。");
  }

  /* ---------- 學習狀態：只存在記憶體 ---------- */

  function refreshRoot(root) {
    const reading = !studyInlineEditing;
    root.classList.toggle("cr-cloze-reading", reading);

    const firstById = new Set();

    root.querySelectorAll(MARK).forEach(marker => {
      if (!reading) {
        [
          "data-cloze-open",
          "role",
          "tabindex",
          "aria-label",
          "aria-expanded"
        ].forEach(name => marker.removeAttribute(name));
        return;
      }

      const open = revealed.has(keyFor(root, marker));
      const id = marker.dataset.clozeId;

      marker.toggleAttribute("data-cloze-open", open);
      marker.setAttribute("role", "button");
      marker.setAttribute("aria-expanded", String(open));
      marker.setAttribute(
        "aria-label",
        open ? `${marker.textContent}，按一下隱藏` : "填空，按一下顯示"
      );

      marker.tabIndex = firstById.has(id) ? -1 : 0;
      firstById.add(id);
    });
  }
function updateClozeDock() {
  const stage = byId("studyStage");
  if (!stage) return;

  let dock = byId("crClozeDock");

  if (!dock) {
    dock = document.createElement("div");
    dock.id = "crClozeDock";
    dock.setAttribute("role", "group");
    dock.setAttribute("aria-label", "本卡填空控制");

    dock.innerHTML = `
      <small data-cr-status></small>
      <div class="cr-cloze-dock-actions">
        <button
          type="button"
          data-cr-command="show-card"
          title="顯示本卡問題及答案中的所有填空，不翻面"
        >顯示全部</button>
        <button
          type="button"
          data-cr-command="hide-card"
          title="隱藏本卡問題及答案中的所有填空，不翻面"
        >隱藏全部</button>
      </div>
    `;

    stage.appendChild(dock);
  }

  const groups = new Set();

  studyRoots().forEach(root => {
    root.querySelectorAll(MARK).forEach(marker => {
      groups.add(keyFor(root, marker));
    });
  });

  const editing = !!studyInlineEditing;
  const unavailable = !currentNote() || groups.size === 0;

  dock.querySelectorAll("button").forEach(button => {
    button.disabled = editing || unavailable;
  });

  const status = editing
    ? "編輯中：儲存後可測試填空"
    : unavailable
      ? "本卡沒有填空"
      : `本卡填空 ${groups.size} 組`;

  const label = dock.querySelector("[data-cr-status]");
  if (label.textContent !== status) label.textContent = status;
}

function setWholeCardCloze(open) {
  if (!currentNote()) return;

  if (studyInlineEditing) {
    toast("請先儲存或取消編輯");
    return;
  }

  prepareStudy();

  studyRoots().forEach(root => {
    root.querySelectorAll(MARK).forEach(marker => {
      const key = keyFor(root, marker);

      if (open) revealed.add(key);
      else revealed.delete(key);
    });
  });

  if (!open) window.stopEnglishSpeech?.();

  studyRoots().forEach(refreshRoot);
  updateClozeDock();
}
  function prepareStudy() {
    const note = currentNote();
    if (!note) return;

    const id = String(note.id);

    if (session !== studyState || currentNoteId !== id) {
      session = studyState;
      currentNoteId = id;
      revealed.clear();
      savedSelection = null;
      closeMenu();
      cancelGesture();

      window.stopEnglishSpeech?.();
    }

    studyRoots().forEach(refreshRoot);
    updateClozeDock();
  }

  function studyMarker(target) {
    const marker = closest(target, MARK);
    const root = marker?.closest(".cr-cloze-reading");

    if (
      !root ||
      !STUDY_IDS.includes(root.id) ||
      !currentNote() ||
      studyInlineEditing
    ) {
      return null;
    }

    return { marker, root };
  }

  function toggleReveal(marker, root) {
    const key = keyFor(root, marker);

    if (revealed.has(key)) {
      revealed.delete(key);
      window.stopEnglishSpeech?.();
    } else {
      revealed.add(key);
    }

    studyRoots().forEach(refreshRoot);
  }

  function setAll(root, open) {
    if (!root?.isConnected || !currentNote() || studyInlineEditing) return;

    root.querySelectorAll(MARK).forEach(marker => {
      const key = keyFor(root, marker);
      if (open) revealed.add(key);
      else revealed.delete(key);
    });

    if (!open) window.stopEnglishSpeech?.();

    studyRoots().forEach(refreshRoot);
  }

  /* ---------- 本區全部顯示／隱藏選單 ---------- */

  function closeMenu() {
    byId("crClozeMenu")?.remove();
    menuRoot = null;
    menuNoteId = "";
  }

  function openMenu(root, x, y) {
    closeMenu();

    menuRoot = root;
    menuNoteId = String(currentNote()?.id || "");

    const menu = document.createElement("div");
    menu.id = "crClozeMenu";
    menu.innerHTML = `
      <button type="button" data-cr-command="show">
        顯示本區全部填空
      </button>
      <button type="button" data-cr-command="hide">
        隱藏本區全部填空
      </button>
    `;

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();

    menu.style.left =
      `${Math.max(10, Math.min(x, innerWidth - rect.width - 10))}px`;

    menu.style.top =
      `${Math.max(10, Math.min(y, innerHeight - rect.height - 10))}px`;
  }

  function command(button) {
    const action = button.dataset.crCommand;
if (button.disabled) return;

  if (action === "show-card" || action === "hide-card") {
    closeMenu();
    setWholeCardCloze(action === "show-card");
    return;
  }
    if (action === "mark") {
      const editor = button.dataset.crEditor === "study"
        ? getStudyEditableTargets()[studyEditingTarget]
        : byId(button.dataset.crEditor);

      toggleMark(editor);
      return;
    }

    const root = menuRoot;
    const valid = menuNoteId === String(currentNote()?.id || "");

    closeMenu();

    if (valid) setAll(root, action === "show");
  }

  /* ---------- 點擊、觸控、鍵盤 ---------- */

  function cancelGesture() {
    clearTimeout(holdTimer);
    holdTimer = null;
    gesture = null;
  }

  /*
    使用 window capture，先於原有卡片翻面 handler。
    只攔截填空和本模組按鈕，其餘事件保持原樣。
  */
  window.addEventListener("pointerdown", event => {
    if (event.isPrimary === false) {
      cancelGesture();
      return;
    }

    if (event.button !== 0) return;

    const button = closest(event.target, "[data-cr-command]");
    const hit = studyMarker(event.target);

    if (!closest(event.target, "#crClozeMenu")) closeMenu();

    if (!button && !hit) {
      cancelGesture();
      return;
    }

    if (button?.dataset.crCommand === "mark") {
      rememberSelection();
    }

    cancelGesture();

    gesture = {
      pointerId: event.pointerId,
      target: button || hit.marker,
      root: hit?.root,
      button,
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      moved: false,
      held: false,
      noteId: String(currentNote()?.id || "")
    };

    if (button) event.preventDefault();

    event.stopImmediatePropagation();

    if (hit) {
      holdTimer = setTimeout(() => {
        const g = gesture;

        if (
          !g ||
          g.moved ||
          !g.target.isConnected ||
          g.noteId !== String(currentNote()?.id || "")
        ) {
          return;
        }

        g.held = true;
        openMenu(g.root, g.x, g.y);
      }, 550);
    }
  }, true);

  window.addEventListener("pointermove", event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    if (
      Math.hypot(
        event.clientX - gesture.x,
        event.clientY - gesture.y
      ) > 10
    ) {
      gesture.moved = true;
      clearTimeout(holdTimer);
    }
  }, true);

  window.addEventListener("pointerup", event => {
    const g = gesture;

    if (!g || g.pointerId !== event.pointerId) return;

    cancelGesture();

    event.stopImmediatePropagation();

    const target = closest(
      event.target,
      g.button ? "[data-cr-command]" : MARK
    );

    if (
      g.moved ||
      g.held ||
      !g.target.isConnected ||
      target !== g.target ||
      Date.now() - g.time > 700 ||
      g.noteId !== String(currentNote()?.id || "")
    ) {
      return;
    }

    event.preventDefault();

    if (g.button) command(g.button);
    else toggleReveal(g.target, g.root);
  }, true);

  window.addEventListener("pointercancel", cancelGesture, true);
  window.addEventListener("blur", cancelGesture);

  window.addEventListener("scroll", () => {
    if (gesture) {
      gesture.moved = true;
      clearTimeout(holdTimer);
    }
  }, true);

  window.addEventListener("click", event => {
    const button = closest(event.target, "[data-cr-command]");
    const hit = studyMarker(event.target);

    if (!button && !hit) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    /*
      Pointer click 已由 pointerup 處理。
      detail=0 保留鍵盤及輔助工具的啟動方式。
    */
    if (event.detail === 0) {
      if (button) command(button);
      else toggleReveal(hit.marker, hit.root);
    }
  }, true);

  window.addEventListener("contextmenu", event => {
    const hit = studyMarker(event.target);
    if (!hit) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (gesture) gesture.held = true;
    clearTimeout(holdTimer);

    openMenu(hit.root, event.clientX, event.clientY);
  }, true);

  window.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeMenu();
      return;
    }

    if (event.isComposing) return;

    const shortcut =
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.code === "KeyK";

    if (shortcut) {
      const editor = closest(document.activeElement, EDITOR_SELECTOR);
      if (!editorOwner(editor)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      rememberSelection();
      toggleMark(editor);
      return;
    }

    const hit = studyMarker(event.target);

    if (hit && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (!event.repeat) toggleReveal(hit.marker, hit.root);
    }
  }, true);

  document.addEventListener("selectionchange", rememberSelection);

  /* ---------- 朗讀：只讀目前可看的區域 ---------- */

  function visibleText(root) {
    if (!root) return "";

    const copy = root.cloneNode(true);

    if (!studyInlineEditing) {
      copy.querySelectorAll(
        `${MARK}:not([data-cloze-open])`
      ).forEach(marker => {
        marker.replaceWith(document.createTextNode(" "));
      });
    }

    copy.querySelectorAll("br").forEach(node => {
      node.replaceWith(document.createTextNode(" "));
    });

    copy.querySelectorAll("p, div, li, td, th").forEach(node => {
      node.appendChild(document.createTextNode(" "));
    });

    return (copy.textContent || "").replace(/\s+/g, " ").trim();
  }

  function speechText() {
    if (!currentNote()) return "";

    const split = studyState.preferences.viewMode === "split";
    const question = byId(split ? "studyQuestionSplit" : "studyQuestion");
    const answer = byId(split ? "studyAnswerSplit" : "studyAnswer");

    const candidates = split
      ? (studyState.answerVisible ? [answer, question] : [question])
      : [studyState.answerVisible ? answer : question];

    for (const root of candidates) {
      const text = visibleText(root);
      if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(text)) return text;
    }

    return "";
  }

  /* ---------- 工具列 ---------- */

  function makeTool(editorId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-btn cr-cloze-tool";
    button.dataset.crCommand = "mark";
    button.dataset.crEditor = editorId;
    button.textContent = "填空";
    button.title = "建立／取消填空（⌘ / Ctrl + Shift + K）";
    return button;
  }

  function init() {
    ["questionEditor", "answerEditor"].forEach(id => {
      const toolbar = byId(id)?.previousElementSibling;

      if (
        !toolbar?.classList.contains("editor-toolbar") ||
        toolbar.querySelector("[data-cr-command='mark']")
      ) {
        return;
      }

      toolbar.appendChild(makeTool(id));
    });

    const bar = byId("studyInlineEditBar");

    if (bar && !bar.querySelector("[data-cr-command='mark']")) {
      const save = byId("studySaveInlineBtn");
      bar.insertBefore(makeTool("study"), save || null);
    }
  }

  window.CreamyCloze = {
    prepareStudy,
    speechText,
    init,
    version: "2"
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
