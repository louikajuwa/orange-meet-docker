// Top-level YT API ready handler — must load before the YouTube iframe_api
// script so it exists when the API calls it. app.js sets window.__ytReadyHandler.
window.__ytApiLoaded = false;
window.onYouTubeIframeAPIReady = function(){
  window.__ytApiLoaded = true;
  if(typeof window.__ytReadyHandler === "function") window.__ytReadyHandler();
};
