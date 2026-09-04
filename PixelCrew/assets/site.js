(() => {
  const isChinese = document.documentElement.lang.startsWith("zh");

  document.querySelectorAll("[data-mode-stage]").forEach((stage) => {
    const tabs = [...stage.querySelectorAll("[data-mode-tab]")];
    const panels = [...stage.querySelectorAll("[data-mode-panel]")];
    const motionButton = stage.querySelector("[data-motion-toggle]");
    const liveImage = stage.querySelector("[data-live-image]");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motionPaused = reducedMotion.matches;
    let motionWasChosen = false;

    const renderMotion = () => {
      if (!liveImage || !motionButton) return;
      liveImage.src = motionPaused ? liveImage.dataset.staticSrc : liveImage.dataset.animatedSrc;
      motionButton.setAttribute("aria-pressed", String(motionPaused));
      motionButton.textContent = motionPaused
        ? (isChinese ? "播放動態" : "Play motion")
        : (isChinese ? "暫停動態" : "Pause motion");
    };

    const selectMode = (mode, focus = false) => {
      tabs.forEach((tab) => {
        const selected = tab.dataset.modeTab === mode;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.modePanel !== mode;
      });
      if (motionButton) motionButton.hidden = mode !== "pixel";
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => selectMode(tab.dataset.modeTab));
      tab.addEventListener("keydown", (event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        selectMode(tabs[next].dataset.modeTab, true);
      });
    });

    motionButton?.addEventListener("click", () => {
      motionWasChosen = true;
      motionPaused = !motionPaused;
      renderMotion();
    });
    reducedMotion.addEventListener?.("change", (event) => {
      if (!motionWasChosen) {
        motionPaused = event.matches;
        renderMotion();
      }
    });

    renderMotion();
  });
})();
