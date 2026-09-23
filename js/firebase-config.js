/**
 * SV PLAST - Centralized Cloud Database Hub
 * Powered by Google Firebase Firestore (100% Free Forever)
 *
 * This provides real-time, global synchronization across all devices,
 * Chrome profiles, and visitors. When you delete or add a post in Admin Studio,
 * it updates instantly everywhere with zero delay.
 */

const SV_FIREBASE_DEFAULT_CONFIG = {
  apiKey: "AIzaSyBwtwpPkT8bMobdJcX634IUBlFrKcssBT0",
  authDomain: "sv-plast1.firebaseapp.com",
  projectId: "sv-plast1",
  storageBucket: "sv-plast1.firebasestorage.app",
  messagingSenderId: "1066950515619",
  appId: "1:1066950515619:web:682154e5f5b1167411d816"
};

// Allow config override from localStorage or environment
function getFirebaseConfig() {
  try {
    const saved = localStorage.getItem('sv_firebase_config');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.projectId && parsed.apiKey) {
        return parsed;
      }
    }
  } catch (e) {}

  if (SV_FIREBASE_DEFAULT_CONFIG.projectId && SV_FIREBASE_DEFAULT_CONFIG.apiKey) {
    return SV_FIREBASE_DEFAULT_CONFIG;
  }
  return null;
}

// Helper to convert Firestore REST API document fields to clean JS object
function parseFirestoreFields(fields) {
  if (!fields) return {};
  const res = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) res[k] = v.stringValue;
    else if (v.integerValue !== undefined) res[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) res[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) res[k] = v.booleanValue;
    else if (v.arrayValue !== undefined) {
      res[k] = (v.arrayValue.values || []).map(item => {
        if (item.mapValue) return parseFirestoreFields(item.mapValue.fields);
        if (item.stringValue !== undefined) return item.stringValue;
        return item;
      });
    } else if (v.mapValue !== undefined) {
      res[k] = parseFirestoreFields(v.mapValue.fields);
    }
  }
  return res;
}

class SVCloudHub {
  constructor() {
    this.app = null;
    this.db = null;
    this.isInitialized = false;
    this.subscribers = [];
    this.cachedData = null;
    this.init();
  }

  init() {
    const config = getFirebaseConfig();
    if (!config) {
      console.log('SV Cloud Hub: Firebase credentials not yet configured. Operating in local/seed mode.');
      return;
    }

    const tryConnect = () => {
      try {
        if (typeof firebase !== 'undefined') {
          if (!firebase.apps.length) {
            this.app = firebase.initializeApp(config);
          } else {
            this.app = firebase.app();
          }
          this.db = firebase.firestore();
          this.isInitialized = true;
          console.log('SV Cloud Hub: Connected to Firestore centralized database (' + config.projectId + ')');
          this.listenForRealtimeUpdates();
          return true;
        }
      } catch (err) {
        console.error('SV Cloud Hub: Firebase initialization error:', err);
      }
      return false;
    };

    if (!tryConnect()) {
      window.addEventListener('DOMContentLoaded', () => {
        if (!this.isInitialized) tryConnect();
      });
      setTimeout(() => {
        if (!this.isInitialized) tryConnect();
      }, 500);
    }
  }

  isConfigured() {
    return (this.isInitialized && this.db !== null) || Boolean(getFirebaseConfig());
  }

  saveConfig(newConfig) {
    try {
      if (newConfig && newConfig.projectId && newConfig.apiKey) {
        localStorage.setItem('sv_firebase_config', JSON.stringify(newConfig));
        location.reload();
        return true;
      }
    } catch (e) {
      console.error(e);
    }
    return false;
  }

  listenForRealtimeUpdates() {
    if (!this.db) return;
    this.db.collection('sv_media').doc('content').onSnapshot((doc) => {
      if (doc.exists) {
        this.cachedData = doc.data();
        this.notifySubscribers(this.cachedData);
      }
    }, (err) => {
      console.warn('SV Cloud Hub: Snapshot listener notice:', err);
    });
  }

  subscribe(callback) {
    if (typeof callback === 'function') {
      this.subscribers.push(callback);
      if (this.cachedData) {
        callback(this.cachedData);
      }
    }
  }

  notifySubscribers(data) {
    this.subscribers.forEach(cb => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  }

  // Fetch all media items
  async getMedia() {
    if (this.isInitialized && this.db) {
      try {
        const docRef = this.db.collection('sv_media').doc('content');
        const doc = await docRef.get();
        if (doc.exists) {
          this.cachedData = doc.data();
          return this.cachedData;
        } else {
          // First-time initialization: seed Firestore from local data/media.json
          const seedData = await this.fetchSeedData();
          if (seedData) {
            await docRef.set(seedData);
            this.cachedData = seedData;
            return seedData;
          }
        }
      } catch (err) {
        console.warn('SV Cloud Hub: Firestore SDK fetch error, trying REST API fallback:', err);
      }
    }

    // Direct Firestore REST API fetch
    const config = getFirebaseConfig();
    if (config && config.projectId && config.apiKey) {
      try {
        const getUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/sv_media/content?key=${config.apiKey}`;
        const res = await fetch(getUrl);
        if (res.ok) {
          const doc = await res.json();
          const parsed = parseFirestoreFields(doc.fields);
          if (parsed && (parsed.instagram || parsed.youtube || parsed.gallery)) {
            this.cachedData = parsed;
            return this.cachedData;
          }
        }
      } catch (restErr) {
        console.warn('SV Cloud Hub: REST API fetch error:', restErr);
      }
    }

    return await this.fetchSeedData();
  }

  async fetchSeedData() {
    try {
      const res = await fetch('data/media.json?t=' + Date.now());
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('Could not fetch seed data/media.json:', e);
    }
    return { instagram: [], youtube: [], gallery: [] };
  }

  // Add new media item (supports single item or array)
  async addItem(section, itemData) {
    return this.addItems(section, Array.isArray(itemData) ? itemData : [itemData]);
  }

  // Add multiple media items in a single cloud write
  async addItems(section, itemsArray) {
    if (!['instagram', 'youtube', 'gallery'].includes(section)) {
      throw new Error('Invalid section: ' + section);
    }
    const list = Array.isArray(itemsArray) ? itemsArray : [itemsArray];
    if (list.length === 0) {
      return { success: true, data: this.cachedData };
    }

    const cleanList = JSON.parse(JSON.stringify(list));

    if (this.isConfigured()) {
      try {
        const docRef = this.db.collection('sv_media').doc('content');
        const doc = await docRef.get();
        let currentData = doc.exists ? doc.data() : await this.fetchSeedData();
        if (!currentData[section]) currentData[section] = [];

        // Add to top of list
        currentData[section].unshift(...cleanList);

        // Save back with merge: true
        await docRef.set({ [section]: currentData[section] }, { merge: true });
        this.cachedData = currentData;
        this.notifySubscribers(currentData);
        return { success: true, data: currentData };
      } catch (e) {
        console.warn('SV Cloud Hub: addItems SDK error, trying REST API fallback:', e);
      }
    }

    // Direct Firestore REST API fallback
    const config = getFirebaseConfig();
    if (config && config.projectId && config.apiKey) {
      try {
        const currentData = (await this.fetchSeedData()) || { [section]: [] };
        const existing = (this.cachedData && this.cachedData[section]) || currentData[section] || [];
        const merged = [...cleanList, ...existing];

        const restValues = merged.map(item => {
          const fields = {};
          for (const key in item) {
            if (item[key] !== undefined && item[key] !== null) {
              fields[key] = { stringValue: String(item[key]) };
            }
          }
          return { mapValue: { fields } };
        });

        const patchUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/sv_media/content?updateMask.fieldPaths=${section}&key=${config.apiKey}`;
        const restRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              [section]: { arrayValue: { values: restValues } }
            }
          })
        });

        if (restRes.ok) {
          if (!this.cachedData) this.cachedData = {};
          this.cachedData[section] = merged;
          this.notifySubscribers(this.cachedData);
          return { success: true, data: this.cachedData };
        }
      } catch (restErr) {
        console.warn('SV Cloud Hub: addItems REST error:', restErr);
      }
    }

    // Fallback: try local server API if running local Node server
    try {
      const res = await fetch('/api/media/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, items: cleanList, ...cleanList[0] })
      });
      if (res.ok) return await res.json();
    } catch (e) {}

    return { success: false, message: 'Cloud database not connected.' };
  }

  // Update order of items in a section (with merge: true and REST API fallback)
  async updateOrder(section, reorderedItems) {
    if (!['instagram', 'youtube', 'gallery'].includes(section)) {
      throw new Error('Invalid section: ' + section);
    }
    if (!Array.isArray(reorderedItems)) {
      throw new Error('reorderedItems must be an array');
    }

    // Remove any undefined or circular values
    const cleanItems = JSON.parse(JSON.stringify(reorderedItems));

    // 1. Try Firebase Firestore SDK with merge: true (fast & targeted)
    if (this.isConfigured()) {
      try {
        const docRef = this.db.collection('sv_media').doc('content');
        await docRef.set({ [section]: cleanItems }, { merge: true });
        if (!this.cachedData) this.cachedData = {};
        this.cachedData[section] = cleanItems;
        this.notifySubscribers(this.cachedData);
        return { success: true, message: 'Order updated in cloud.', data: cleanItems };
      } catch (sdkErr) {
        console.warn('SV Cloud Hub: Firestore SDK updateOrder failed, trying REST API fallback:', sdkErr);
      }
    }

    // 2. Direct Firestore REST API fallback (100% reliable, zero SDK dependency)
    const config = getFirebaseConfig();
    if (config && config.projectId && config.apiKey) {
      try {
        const restValues = cleanItems.map(item => {
          const fields = {};
          for (const key in item) {
            if (item[key] !== undefined && item[key] !== null) {
              fields[key] = { stringValue: String(item[key]) };
            }
          }
          return { mapValue: { fields } };
        });

        const patchUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/sv_media/content?updateMask.fieldPaths=${section}&key=${config.apiKey}`;
        const restRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              [section]: { arrayValue: { values: restValues } }
            }
          })
        });

        if (restRes.ok) {
          if (!this.cachedData) this.cachedData = {};
          this.cachedData[section] = cleanItems;
          this.notifySubscribers(this.cachedData);
          return { success: true, message: 'Order updated in cloud via REST.', data: cleanItems };
        }
      } catch (restErr) {
        console.warn('SV Cloud Hub: REST API fallback error:', restErr);
      }
    }

    // 3. Fallback: try local server API if running local Node server
    try {
      const res = await fetch('/api/media/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, items: cleanItems })
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: 'Order updated on local server.', data };
      }
    } catch (e) {}

    return { success: false, message: 'Could not connect to cloud to update order.' };
  }

  // Delete media item permanently from cloud
  async deleteItem(section, id) {
    if (!['instagram', 'youtube', 'gallery'].includes(section)) {
      throw new Error('Invalid section: ' + section);
    }

    if (this.isConfigured()) {
      try {
        const docRef = this.db.collection('sv_media').doc('content');
        const doc = await docRef.get();
        if (doc.exists) {
          let currentData = doc.data();
          if (Array.isArray(currentData[section])) {
            const filtered = currentData[section].filter(item => item.id !== id);
            await docRef.set({ [section]: filtered }, { merge: true });
            currentData[section] = filtered;
            this.cachedData = currentData;
            this.notifySubscribers(currentData);
            return { success: true, message: 'Item deleted permanently from cloud hub.', data: currentData };
          }
        }
      } catch (sdkErr) {
        console.warn('SV Cloud Hub: deleteItem SDK error, trying REST API fallback:', sdkErr);
      }
    }

    // Direct Firestore REST API fallback for delete
    const config = getFirebaseConfig();
    if (config && config.projectId && config.apiKey) {
      try {
        const getUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/sv_media/content?key=${config.apiKey}`;
        const getRes = await fetch(getUrl);
        if (getRes.ok) {
          const docJson = await getRes.json();
          const currentValues = docJson.fields?.[section]?.arrayValue?.values || [];
          const filteredValues = currentValues.filter(v => v.mapValue?.fields?.id?.stringValue !== id);

          const patchUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/sv_media/content?updateMask.fieldPaths=${section}&key=${config.apiKey}`;
          const patchRes = await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                [section]: { arrayValue: { values: filteredValues } }
              }
            })
          });

          if (patchRes.ok) {
            if (this.cachedData && Array.isArray(this.cachedData[section])) {
              this.cachedData[section] = this.cachedData[section].filter(item => item.id !== id);
              this.notifySubscribers(this.cachedData);
            }
            return { success: true, message: 'Item deleted permanently via REST.' };
          }
        }
      } catch (restErr) {
        console.warn('SV Cloud Hub: REST API delete error:', restErr);
      }
    }

    // Fallback: try local server API if running local Node server
    try {
      const res = await fetch(`/api/media/delete?section=${encodeURIComponent(section)}&id=${encodeURIComponent(id)}`, {
        method: 'POST'
      });
      if (res.ok) return await res.json();
    } catch (e) {}

    return { success: false, message: 'Could not connect to cloud database to delete.' };
  }
}

// Global Cloud Hub instance
window.SVCloud = new SVCloudHub();
