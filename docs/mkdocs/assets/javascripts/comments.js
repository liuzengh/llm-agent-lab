(function () {
  var GISCUS_ORIGIN = "https://giscus.app";
  var COMMENT_SECTION_ID = "giscus-comments";

  var config = {
    repo: "liuzengh/llm-agent-lab",
    repoId: "R_kgDOTLe_VQ",
    category: "General",
    categoryId: "DIC_kwDOTLe_Vc4DAZbP",
  };

  function isBlogArticlePage() {
    return /\/blog\/[^/]+\/?$/.test(window.location.pathname);
  }

  function getGiscusTheme() {
    return document.body &&
      document.body.getAttribute("data-md-color-scheme") === "slate"
      ? "dark"
      : "light";
  }

  function sendGiscusConfig(configUpdate) {
    var frame = document.querySelector("iframe.giscus-frame");

    if (!frame || !frame.contentWindow) {
      return;
    }

    frame.contentWindow.postMessage(
      { giscus: { setConfig: configUpdate } },
      GISCUS_ORIGIN
    );
  }

  function syncGiscusTheme() {
    sendGiscusConfig({ theme: getGiscusTheme() });
  }

  function createGiscusScript() {
    var script = document.createElement("script");

    script.src = GISCUS_ORIGIN + "/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.setAttribute("data-repo", config.repo);
    script.setAttribute("data-repo-id", config.repoId);
    script.setAttribute("data-category", config.category);
    script.setAttribute("data-category-id", config.categoryId);
    script.setAttribute("data-mapping", "pathname");
    script.setAttribute("data-strict", "1");
    script.setAttribute("data-reactions-enabled", "1");
    script.setAttribute("data-emit-metadata", "0");
    script.setAttribute("data-input-position", "bottom");
    script.setAttribute("data-order", "oldest");
    script.setAttribute("data-theme", getGiscusTheme());
    script.setAttribute("data-lang", "zh-CN");
    script.setAttribute("data-loading", "lazy");

    return script;
  }

  function removeComments() {
    var existing = document.getElementById(COMMENT_SECTION_ID);

    if (existing) {
      existing.remove();
    }
  }

  function mountComments() {
    var article = document.querySelector(".md-content__inner");
    var existing = document.getElementById(COMMENT_SECTION_ID);

    if (!isBlogArticlePage()) {
      removeComments();
      return;
    }

    if (!article) {
      return;
    }

    if (existing && existing.getAttribute("data-path") === window.location.pathname) {
      return;
    }

    removeComments();

    var section = document.createElement("section");
    var title = document.createElement("h2");

    section.id = COMMENT_SECTION_ID;
    section.className = "giscus-comments";
    section.setAttribute("data-path", window.location.pathname);
    title.className = "giscus-comments__title";
    title.textContent = "评论";

    section.appendChild(title);
    section.appendChild(createGiscusScript());
    article.appendChild(section);
  }

  function watchThemeChanges() {
    if (!document.body || typeof MutationObserver === "undefined") {
      return;
    }

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.attributeName === "data-md-color-scheme") {
          syncGiscusTheme();
        }
      });
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-md-color-scheme"],
    });
  }

  function initComments() {
    mountComments();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initComments);
  } else {
    initComments();
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(initComments);
  }

  watchThemeChanges();
})();
