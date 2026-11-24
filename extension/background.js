// Clicking the toolbar icon opens the game in its own tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('game.html') });
});
