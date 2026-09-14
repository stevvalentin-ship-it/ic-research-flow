/* Pinned local MathJax 3.2.1. SVG output: no web-font downloads. */
window.MathJax = {
  startup: {typeset: false},
  loader: {load: []},
  tex: {
    packages: ['base', 'ams', 'noundefined'],
    maxBuffer: 10000, maxMacros: 1000, tags: 'none'
  },
  options: {enableMenu: false, enableAssistiveMml: false},
  svg: {fontCache: 'local'}
};
