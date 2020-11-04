import type { ExtensionId, ExtensionManifest, ExtensionModel, LensExtension } from "./lens-extension"
import type { LensMainExtension } from "./lens-main-extension"
import type { LensRendererExtension } from "./lens-renderer-extension"
import path from "path"
import { broadcastMessage, subscribeToBroadcast } from "../common/ipc"
import { observable, reaction, toJS, } from "mobx"
import logger from "../main/logger"
import { app, ipcRenderer, remote } from "electron"
import { appEventBus } from "./core-api/event-bus"
import { clusterStore } from "./core-api/stores"
import {
  appPreferenceRegistry, clusterFeatureRegistry, clusterPageRegistry, globalPageRegistry,
  kubeObjectDetailRegistry, kubeObjectMenuRegistry, menuRegistry, statusBarRegistry
} from "./registries";

export interface InstalledExtension extends ExtensionModel {
  manifestPath: string;
  manifest: ExtensionManifest;
}

// lazy load so that we get correct userData
export function extensionPackagesRoot() {
  return path.join((app || remote.app).getPath("userData"))
}

export class ExtensionLoader {
  @observable extensions = observable.map<ExtensionId, InstalledExtension>([], { deep: false });
  @observable instances = observable.map<ExtensionId, LensExtension>([], { deep: false })

  constructor() {
    if (ipcRenderer) {
      subscribeToBroadcast("extensions:loaded", (event, extensions: InstalledExtension[]) => {
        extensions.forEach((ext) => {
          if (!this.getById(ext.manifestPath)) {
            this.extensions.set(ext.manifestPath, ext)
          }
        })
      })
    } else {
      reaction(() => this.extensions.toJS(), () => {
        this.broadcastExtensions()
      })
      appEventBus.addListener((ev) => {
        if (ev.name === "app" && ev.action === "dom-ready") {
          this.broadcastExtensions()
        }
      })
      reaction(() => clusterStore.connectedClustersList, () => {
        this.broadcastExtensions()
      })
    }
  }

  loadOnMain() {
    logger.info('[EXTENSIONS-LOADER]: load on main')
    this.autoloadExtensions((extension: LensMainExtension) => {
      extension.registerTo(menuRegistry, extension.appMenus)
    })
  }

  loadOnClusterManagerRenderer() {
    logger.info('[EXTENSIONS-LOADER]: load on main renderer (cluster manager)')
    this.autoloadExtensions((extension: LensRendererExtension) => {
      extension.registerTo(globalPageRegistry, extension.globalPages)
      extension.registerTo(appPreferenceRegistry, extension.appPreferences)
      extension.registerTo(clusterFeatureRegistry, extension.clusterFeatures)
      extension.registerTo(statusBarRegistry, extension.statusBarItems)
    })
  }

  loadOnClusterRenderer() {
    logger.info('[EXTENSIONS-LOADER]: load on cluster renderer (dashboard)')
    this.autoloadExtensions((extension: LensRendererExtension) => {
      extension.registerTo(clusterPageRegistry, extension.clusterPages)
      extension.registerTo(kubeObjectMenuRegistry, extension.kubeObjectMenuItems)
      extension.registerTo(kubeObjectDetailRegistry, extension.kubeObjectDetailItems)
    })
  }

  protected autoloadExtensions(callback: (instance: LensExtension) => void) {
    return reaction(() => this.extensions.toJS(), (installedExtensions) => {
      for(const [id, ext] of installedExtensions) {
        let instance = this.instances.get(ext.id)
        if (!instance) {
          const extensionModule = this.requireExtension(ext)
          if (!extensionModule) {
            continue
          }
          const LensExtensionClass = extensionModule.default;
          instance = new LensExtensionClass({ ...ext.manifest, manifestPath: ext.manifestPath, id: ext.manifestPath }, ext.manifest);
          try {
            instance.enable()
            callback(instance)
          } finally {
            this.instances.set(ext.id, instance)
          }
        }
      }
    }, {
      fireImmediately: true,
      delay: 0,
    })
  }

  protected requireExtension(extension: InstalledExtension) {
    let extEntrypoint = ""
    try {
      if (ipcRenderer && extension.manifest.renderer) {
        extEntrypoint = path.resolve(path.join(path.dirname(extension.manifestPath), extension.manifest.renderer))
      } else if (!ipcRenderer && extension.manifest.main) {
        extEntrypoint = path.resolve(path.join(path.dirname(extension.manifestPath), extension.manifest.main))
      }
      if (extEntrypoint !== "") {
        return __non_webpack_require__(extEntrypoint)
      }
    } catch (err) {
      console.error(`[EXTENSION-LOADER]: can't load extension main at ${extEntrypoint}: ${err}`, { extension });
      console.trace(err)
    }
  }

  getById(id: ExtensionId): InstalledExtension {
    return this.extensions.get(id);
  }

  async removeById(id: ExtensionId) {
    const extension = this.getById(id);
    if (extension) {
      const instance = this.instances.get(extension.id)
      if (instance) {
        await instance.disable()
      }
      this.extensions.delete(id);
    }
  }

  broadcastExtensions() {
    broadcastMessage("extensions:loaded", this.toJSON().extensions)
  }

  toJSON() {
    return toJS({
      extensions: Array.from(this.extensions).map(([id, instance]) => instance),
    }, {
      recurseEverything: true,
    })
  }
}

export const extensionLoader = new ExtensionLoader()
