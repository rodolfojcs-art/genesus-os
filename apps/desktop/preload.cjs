// Preload mínimo y seguro: expone solo metadatos no sensibles al renderer.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('genesus', {
  desktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
