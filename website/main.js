// Point the hero button at the visitor's platform and highlight it in the download grid.
(function () {
  var ua = navigator.userAgent || "";
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  var os = null;
  if (/iPhone|iPad|iPod|Android/i.test(ua)) os = "phone";
  else if (/Mac/i.test(platform) || /Mac OS X/.test(ua)) os = "mac";
  else if (/Win/i.test(platform) || /Windows/.test(ua)) os = "win";
  else if (/Linux/i.test(platform) || /Linux/.test(ua)) os = "linux";

  var label = document.getElementById("hero-download-label");
  var names = { mac: "Download for macOS", win: "Download for Windows", linux: "Download for Linux" };
  if (label && names[os]) label.textContent = names[os];
  if (os === "phone") {
    var btn = document.getElementById("hero-download");
    if (btn) btn.setAttribute("href", "#download");
    if (label) label.textContent = "Get PartyLine";
  }

  var match = document.querySelector('.platform[data-os="' + os + '"]');
  if (match) match.classList.add("is-yours");
})();

// Copy buttons next to commands (macOS first-launch step).
document.querySelectorAll(".cmd-copy").forEach(function (b) {
  b.addEventListener("click", function () {
    var el = document.getElementById(b.getAttribute("data-copy"));
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent).then(function () {
      b.textContent = "Copied";
      setTimeout(function () { b.textContent = "Copy"; }, 1500);
    });
  });
});
