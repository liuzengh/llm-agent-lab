(function () {
  function getMermaidTheme() {
    return document.body &&
      document.body.getAttribute("data-md-color-scheme") === "slate"
      ? "dark"
      : "default";
  }

  function convertCodeBlocks() {
    var blocks = document.querySelectorAll("pre.mermaid > code");

    blocks.forEach(function (codeBlock) {
      var pre = codeBlock.parentElement;
      var diagram = document.createElement("div");

      diagram.className = "mermaid";
      diagram.textContent = codeBlock.textContent;
      pre.replaceWith(diagram);
    });
  }

  function renderMermaid() {
    var diagrams;
    var result;

    if (!window.mermaid) {
      return;
    }

    convertCodeBlocks();
    diagrams = Array.from(document.querySelectorAll(".mermaid:not([data-processed])"));

    if (!diagrams.length) {
      return;
    }

    window.mermaid.initialize({
      startOnLoad: false,
      theme: getMermaidTheme(),
    });
    result = window.mermaid.run({ nodes: diagrams });

    if (result && typeof result.catch === "function") {
      result.catch(function (error) {
        console.error("Failed to render Mermaid diagram:", error);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderMermaid);
  } else {
    renderMermaid();
  }

  if (typeof document$ !== "undefined") {
    document$.subscribe(renderMermaid);
  }
})();
