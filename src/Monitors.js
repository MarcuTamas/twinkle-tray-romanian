const w32disp = require("win32-displayconfig");
const wmibridge = require("wmi-bridge");


process.on('message', (data) => {
    try {
        if (data.type === "refreshMonitors") {
            refreshMonitors(data.fullRefresh, data.ddcciType).then((results) => {
                process.send({
                    type: 'refreshMonitors',
                    monitors: results
                })
            })
        } else if (data.type === "brightness") {
            setBrightness(data.brightness, data.id)
        } else if (data.type === "settings") {
            settings = data.settings
        } else if (data.type === "localization") {
            localization = data.localization
        } else if(data.type === "vcp") {
            setVCP(data.monitor, data.code, data.value)
        } else if (data.type === "test") {
            
        }
    } catch(e) {
        console.log(e)
    }
})

let debug = console

let isDev = (process.argv.indexOf("--isdev=true") >= 0)

let monitors = false
let monitorNames = []

let settings = { order: [] }
let localization = {}

let busyLevel = 0
refreshMonitors = async (fullRefresh = false, ddcciType = "default", alwaysSendUpdate = false) => {
    if((busyLevel > 0 && !fullRefresh) || (busyLevel > 1 && fullRefresh)) {
        console.log("Thread busy. Cancelling refresh.")
        return false
    }
    busyLevel = (fullRefresh ? 2 : 1)

    if(!monitors || fullRefresh) {
        monitors = await getAllMonitors()
    } else {
        const startTime = process.hrtime()
        for(const hwid2 in monitors) {
            if(monitors[hwid2].type === "ddcci" && monitors[hwid2].brightnessType) {
                monitors[hwid2] = await getBrightnessDDC(monitors[hwid2])
            }
        }
        console.log(`Refresh Brightness Total: ${process.hrtime(startTime)[1] / 1000000}ms`)
    }

    busyLevel = 0

    return monitors
}


getAllMonitors = async () => {
    const foundMonitors = {}

    const startTime = process.hrtime()

    const monitorsWMI = await getMonitorsWMI()
    const monitorsWin32 = await getMonitorsWin32()
    const featuresList = await getFeaturesDDC()
    const wmiBrightness = await getBrightnessWMI()

    for(const hwid2 in monitorsWMI) {
        const monitor = monitorsWMI[hwid2]
        updateDisplay(foundMonitors, hwid2, monitor)
    }

    for(const hwid2 in monitorsWin32) {
        const monitor = monitorsWin32[hwid2]
        updateDisplay(foundMonitors, hwid2, monitor)
    }

    if(wmiBrightness) {
        updateDisplay(foundMonitors, wmiBrightness.hwid[2], wmiBrightness)
    }

    for(const hwid2 in featuresList) {
        const monitor = featuresList[hwid2]
        const { features, id } = monitor
        let ddcciInfo = {
            id: id,
            features: features,
            type: "ddcci",
            min: 0,
            max: 100,
            brightnessType: (features.luminance ? 0x10 : (features.brightness ? 0x13 : 0x00)),
            brightnessValues: (features.luminance ? features.luminance : (features.brightness ? features.brightness : [50,100]))
        }
        ddcciInfo.brightnessRaw = ddcciInfo.brightnessValues[0]
        ddcciInfo.brightnessMax = ddcciInfo.brightnessValues[1]

        // Get normalization info
        ddcciInfo = applyRemap(ddcciInfo)

        // Unnormalize brightness
        ddcciInfo.brightness = normalizeBrightness(ddcciInfo.brightnessRaw, true, ddcciInfo.min, ddcciInfo.max)
        updateDisplay(foundMonitors, hwid2, ddcciInfo) 
    }

    console.log(`getAllMonitors() total: ${process.hrtime(startTime)[1] / 1000000}ms`)
    return foundMonitors
}

getMonitorsWMI = () => {
    return new Promise((resolve, reject) => {
        const foundMonitors = {}
        try {
            const wmiMonitors = wmibridge.getMonitors();
            if(wmiMonitors.failed) {
                // Something went wrong
                resolve([])
            } else {
                // Sort through results
                for (let monitorHWID in wmiMonitors) {
                    const monitor = wmiMonitors[monitorHWID]

                    let hwid = readInstanceName(monitor.InstanceName)
                    hwid[2] = hwid[2].split("_")[0]
    
                    const wmiInfo = {
                        id: `\\\\?\\${hwid[0]}#${hwid[1]}#${hwid[2]}`,
                        key: hwid[2],
                        hwid: hwid,
                        serial: monitor.SerialNumberID
                    }
    
                    if (monitor.UserFriendlyName !== null && monitor.UserFriendlyName !== "") {
                        wmiInfo.name = monitor.UserFriendlyName
                    }
    
                    foundMonitors[hwid[2]] = wmiInfo
                }
            }
        } catch(e) {
            console.log(`getMonitorsWMI: Failed to get all monitors.`)
            console.log(e)
        }
        resolve(foundMonitors)
    })
}

getMonitorsWin32 = () => {
    let foundDisplays = {}
    return w32disp.queryDisplayConfig().then((config) => {
        try {
            let displays = []
            // Filter results
            for(const display of config.nameArray) {
                if (display.monitorDevicePath) {
                    // Must also have a valid mode
                    let found = config.modeArray.find(mode => mode.value.id === display.id)
                    // If mode found, add to list
                    if (found) displays.push(display);
                }
            }
            
            // Prepare results
            for (const monitor of displays) {
                const hwid = monitor.monitorDevicePath.split("#")
                hwid[2] = hwid[2].split("_")[0]
    
                const win32Info = {
                    id:  `\\\\?\\${hwid[0]}#${hwid[1]}#${hwid[2]}`,
                    key: hwid[2],
                    connector: monitor.outputTechnology,
                    hwid: hwid
                }
                if (monitor.monitorFriendlyDeviceName?.length > 0) {
                    win32Info.name = monitor.monitorFriendlyDeviceName;
                }
    
                foundDisplays[hwid[2]] = win32Info
            }
    
            // Return prepared results
            return foundDisplays
        } catch(e) {
            console.log(`getMonitorsWin32: Failed to get all monitors. (L2)`)
            console.log(e)
            return foundDisplays
        }
    }).catch((e) => {
        console.log(`getMonitorsWin32: Failed to get all monitors. (L1)`)
        console.log(e)
        return foundDisplays
    })
}

getFeaturesDDC = () => {
    const monitorFeatures = {}
    return new Promise(async (resolve, reject) => {
        try {
            getDDCCI()
            ddcci._refresh()
            const ddcciMonitors = ddcci.getMonitorList()
    
            for (let monitor of ddcciMonitors) {
                const hwid = monitor.split("#")
                let features = []
    
                // Yes, we're doing this 2 times because DDC/CI is flaky sometimes
                features = await checkMonitorFeatures(monitor);
                features = await checkMonitorFeatures(monitor);
    
                monitorFeatures[hwid[2]] = {
                    id:  `${hwid[0]}#${hwid[1]}#${hwid[2]}`,
                    features
                }
            }
        } catch(e) {
            console.log(`getFeaturesDDC: Failed to get features.`)
            console.log(e)
        }

        resolve(monitorFeatures)
    })
}

checkMonitorFeatures = async (monitor) => {
    return new Promise((resolve, reject) => {
        const features = {}
        try {
            // This part is flaky, so we'll do it slowly
            features.luminance = checkVCPIfEnabled(monitor, 0x10, "luminance")
            setTimeout(() => {
                features.brightness = checkVCPIfEnabled(monitor, 0x13, "brightness")
                setTimeout(() => {
                    features.contrast = checkVCPIfEnabled(monitor, 0x12, "contrast")
                    setTimeout(() => {
                        features.powerState = checkVCPIfEnabled(monitor, 0xD6, "powerState")
                        setTimeout(() => {
                            features.volume = checkVCPIfEnabled(monitor, 0x62, "volume")
                            resolve(features)
                        }, 50)
                    }, 50)
                }, 50)
            }, 50)
        } catch (e) {
            resolve(features)
        }
    })
}

getBrightnessWMI = () => {
    // Request WMI monitors.
    return new Promise((resolve, reject) => {
        try {
            const monitor = wmibridge.getBrightness();
            if (monitor.failed) {
                // Something went wrong
                resolve(false)
            } else {
                let hwid = readInstanceName(monitor.InstanceName)
                hwid[2] = hwid[2].split("_")[0]

                let wmiInfo = {
                    id:  `\\\\?\\${hwid[0]}#${hwid[1]}#${hwid[2]}`,
                    brightness: monitor.Brightness,
                    hwid: hwid,
                    min: 0,
                    max: 100,
                    type: 'wmi',
                }

                // Get normalization info
                wmiInfo = applyRemap(wmiInfo)
                
                // Unnormalize brightness
                wmiInfo.brightnessRaw = monitor.Brightness
                wmiInfo.brightness = normalizeBrightness(wmiInfo.brightness, true, wmiInfo.min, wmiInfo.max)

                resolve(wmiInfo)
            }
        } catch (e) {
            console.log(e)
            debug.log(e)
            resolve(false)
        }
    })

}

getBrightnessDDC = (monitorObj) => {
    return new Promise((resolve, reject) => {
        let monitor = Object.assign({}, monitorObj)

        try {
            const ddcciPath = monitor.hwid.join("#")

            // If brightness is not supported, stop
            if(!monitor?.brightnessType) {
                resolve(monitor)
                return false
            }

            // Determine / get brightness
            let brightnessValues = checkVCP(ddcciPath, monitor.brightnessType)

            // If something goes wrong and there are previous values, use those
            if (!brightnessValues) {
                console.log("\x1b[41mNO BRIGHTNESS VALUES AVAILABLE\x1b[0m")
                if (monitor.brightnessRaw !== undefined && monitor.brightnessMax !== undefined) {
                    console.log("\x1b[41mUSING PREVIOUS VALUES\x1b[0m")
                    brightnessValues = [monitor.brightnessRaw, monitor.brightnessMax]
                } else if(vcpCache[monitor] && vcpCache[monitor]["vcp_" + 0x10]) {
                    console.log("\x1b[41mUSING VCP CACHE\x1b[0m")
                    brightnessValues = vcpCache[monitor]["vcp_" + 0x10];
                } else {
                    console.log("CATASTROPHIC FAILURE", monitor)
                    // Catastrophic failure. Revert to defaults.
                    brightnessValues = [50, 100]
                }
            }

            monitor.brightness = brightnessValues[0] * (100 / (brightnessValues[1] || 100))
            monitor.brightnessMax = (brightnessValues[1] || 100)
            monitor.brightnessRaw = brightnessValues[0] // Raw value from DDC/CI. Not normalized or adjusted.


            // Get normalization info
            monitor = applyRemap(monitor)
            // Unnormalize brightness
            monitor.brightness = normalizeBrightness(monitor.brightness, true, monitor.min, monitor.max)
            resolve(monitor)

        } catch(e) {
            console.log("updateBrightnessDDC: Couldn't get DDC/CI brightness.")
            console.log(e)
            resolve(monitorObj)
        }

    })
}

updateDisplay = (monitors, hwid2, info = {}) => {
    if(!monitors[hwid2]) {
        monitors[hwid2] = {
            id: null,
            key: null,
            num: null,
            brightness: 50,
            brightnessMax: 100,
            brightnessRaw: 50,
            type: "none",
            connector: "unknown",
            min: 0,
            max: 100,
            hwid: [],
            name: "Unknown Display",
            serial: null
        }
    }
    Object.assign(monitors[hwid2], info)
    return true
}

function setBrightness(brightness, id) {
    try {
        if (id) {
            let monitor = Object.values(monitors).find(mon => mon.id == id)
            monitor.brightness = brightness
            setVCP(monitor.hwid.join("#"), monitor.brightnessType, brightness)
        } else {
            let monitor = Object.values(monitors).find(mon => mon.type == "wmi")
            monitor.brightness = brightness
            wmibridge.setBrightness(brightness);
        }
    } catch (e) {
        console.log("Couldn't update brightness!");
        console.log(e)
    }
}

let vcpCache = {}
function checkVCPIfEnabled(monitor, code, setting, skipCache = false) {
    try {
        const hwid = monitor.split("#")
        const userEnabledFeature = settings?.monitorFeatures?.[hwid[1]]?.[setting]

        // If we previously saw that a feature was supported, we shouldn't have to check again.
        if ((!skipCache || !userEnabledFeature) && vcpCache[monitor] && vcpCache[monitor]["vcp_" + code]) return vcpCache[monitor]["vcp_" + code];

        const vcpResult = checkVCP(monitor, code)
        return vcpResult
    } catch(e) {
        console.log(e)
        return false
    }
}

function checkVCP(monitor, code, skipCacheWrite = false) {
    try {
        let result = ddcci._getVCP(monitor, code)
        if(!skipCacheWrite) {
            if(!vcpCache[monitor]) vcpCache[monitor] = {};
            vcpCache[monitor]["vcp_" + code] = result
        }
        return result
    } catch (e) {
        return false
    }
}

function setVCP(monitor, code, value) {
    try {
        let result = ddcci._setVCP(monitor, code, (value * 1))
        if(vcpCache[monitor]?.["vcp_" + code]) {
            vcpCache[monitor]["vcp_" + code][0] = (value * 1)
        }
        return result
    } catch (e) {
        return false
    }
}

function normalizeBrightness(brightness, unnormalize = false, min = 0, max = 100) {
    let level = brightness
    if (level > 100) level = 100;
    if (level < 0) level = 0;
    if (min > 0 || max < 100) {
        let out = level
        if (!unnormalize) {
            // Normalize
            out = (min + ((level / 100) * (max - min)))
        } else {
            // Unnormalize
            out = ((level - min) * (100 / (max - min)))
        }
        if (out > 100) out = 100;
        if (out < 0) out = 0;

        return Math.round(out)
    } else {
        return level
    }
}



function applyRemap(monitor) {
    if (settings.remaps) {
        for (let remapName in settings.remaps) {
            if (remapName == monitor.name || remapName == monitor.id) {
                let remap = settings.remaps[remapName]
                monitor.min = remap.min
                monitor.max = remap.max
                // Stop if using new scheme
                if (remapName == monitor.id) return monitor;
            }
        }
    }
    if (typeof monitor.min === "undefined") monitor.min = 0;
    if (typeof monitor.max === "undefined") monitor.max = 100;
    return monitor
}


function readInstanceName(insName) {
    return insName.replace(/&amp;/g, '&').split("\\")
}


let ddcci = false
function getDDCCI() {
    if (ddcci) return true;
    try {
        ddcci = require("@hensm/ddcci");
        return true;
    } catch (e) {
        console.log('Couldn\'t start DDC/CI', e);
        return false;
    }
}
getDDCCI();