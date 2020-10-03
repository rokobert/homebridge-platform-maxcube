var MaxCube = require('maxcube2');
var Thermostat = require('./thermostat');
var ContactSensor = require('./contactsensor');
const mqtt = require('mqtt')
const sprintf=require("sprintf-js").sprintf;

var Service;
var Characteristic;
var _homebridge;

function MaxCubePlatform(log, config){
  this.log = log;
  this.config = config;
  this.wasConnected = false;
  this.paused = false;
  this.windowsensor = config.windowsensor === undefined ? true : config.windowsensor;
  this.myAccessories = [];
  this.myWallThermostat = [];
  this.myAccessories.push(new MaxCubeLinkSwitchAccessory(this.log, this.config, this));
  this.myAccessories.push(new MaxCubeHouseThermostatAccessory(this.log, this.config, this));
  this.updateRate = 10000;
  this.cube = null;
};
MaxCubePlatform.prototype = {
  accessories: function(callback) {
    let that = this;
    this.cube = new MaxCube(this.config.ip, this.config.port);
    this.cube.on('error', function (error) {
      if(!that.wasConnected){
        // We didn't connect yet and got an error,
        // probably the Cube couldn't be reached,
        // DO NOT fulfill the callback so HomeBridge doesn't initialize and delete the devices!
        that.log("Max! Cube could not be found, please restart HomeBridge with Max! Cube connected.");
        //callback(that.myAccessories);
      } else{
        that.log("Max! Cube connection error!");
        // inform HomeKit about connection switch state
        that.myAccessories[0].sendStatus();
        // We were already connected and got an error, it will try and reconnect on the next list update
      }
    });
    this.cube.on('closed', function () {
      that.paused = true;
      that.log("Max! Cube connection closed.");
      that.myAccessories[0].sendStatus();
    });
    this.cube.on('connected', function () {
      that.paused = false;
      that.log("Connected to Max! Cube.");
      // inform HomeKit about connection switch state
      that.myAccessories[0].sendStatus();
      if(!that.wasConnected){
        // first connection, list devices, create accessories and start update loop
        that.cube.getDeviceStatus().then(function (devices) {
          that.wasConnected = true;
          
          if(that.config.allow_wall_thermostat){// if allow first find wall thermostats
            devices.forEach(function (device) {
              var deviceInfo = that.cube.getDeviceInfo(device.rf_address);
              var isWall = deviceInfo.device_type == 3; // true if wall thermostat
              if (isWall) {
                that.myAccessories.push(new Thermostat(_homebridge, that, device));
                that.myWallThermostat.push(deviceInfo);
              }
            });
          }

          devices.forEach(function (device) {
            var deviceInfo = that.cube.getDeviceInfo(device.rf_address);
            var isShutter = deviceInfo.device_type == 4 // true if contact sensor
            //var isWall = that.config.allow_wall_thermostat && (deviceInfo.device_type == 3);
            
            if (isShutter && that.windowsensor) {
              that.myAccessories.push(new ContactSensor(_homebridge, that, device));
            }
            var deviceTypeOk = that.config.only_wall_thermostat ? false : (deviceInfo.device_type == 1 || deviceInfo.device_type == 2);
            if (deviceTypeOk) {
              // check if is room wall thermostat
              let nowt = true
              for(let i = 0; i < that.myWallThermostat.length; ++i){
                let wt = that.myWallThermostat[i]
                if(wt.room_id == deviceInfo.room_id){
                  nowt = false
                  break
                }
              }
              if(nowt) that.myAccessories.push(new Thermostat(_homebridge, that, device));
            }
          });
          callback(that.myAccessories);
          that.updateThermostatData();
          that.setHouseTemp();
        });
      }
    });
    this.startCube();
  },
  startCube: function(){
    this.log("Try connecting to Max! Cube..");
    this.cube.getConnection();
  },
  stopCube: function(){
    this.log("Closing connection to Max! Cube..");
    if(this.cube){
      try{this.cube.close()}catch(error){console.error(error)}
    }
  },
  updateThermostatData: function(){
    // called periodically to trigger maxcube data update
    setTimeout(this.updateThermostatData.bind(this),this.updateRate);
    let that = this;
    if(!this.paused) this.cube.getConnection().then(function () {
      that.cube.updateDeviceStatus();
    });
  },
  setHouseTemp: function (){
    let i = this.myAccessories.length // number of thermostats
    let lt = this.myAccessories[1] // Seltron thermostat
    let tt = lt.offTemp // target temperature
    let ct = 22 // current temperature
    let dif = -30 // diference
    while(i>2){
      --i
      let acc = this.myAccessories[i]
      if(acc.deviceInfo.device_type <=3  && acc.deviceInfo.device_type >=1){
        if(acc.targetHeatingCoolingState != Characteristic.TargetHeatingCoolingState.OFF){
          if(acc.lastNonZeroTemp == 0) continue
          //this.log(acc)
          let df = acc.device.setpoint - acc.lastNonZeroTemp
          //this.log(dif, acc.device.setpoint , acc.lastNonZeroTemp)
          if(df > dif){ // search maximum difference and use current temperature
            dif = df
            ct = acc.lastNonZeroTemp
          }

          const dsp = acc.device.setpoint
          if(acc.lastNonZeroTemp < dsp){ // targe temp must be higher than current          
            if(tt < dsp){ // serach higher target temp
              tt = dsp
            }
          }
        }
      }
    }

    //this.log(ct, lt.currentTemp, tt, lt.targetTemp)
    let sendmqtt = false
    if(lt.currentTemp != ct){
      sendmqtt = true
      lt.currentTemp = ct
      lt.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(lt.currentTemp);
      this.log(lt.name+' - set new temperature, current:'+ lt.currentTemp)
    }
    if(lt.targetTemp != tt){
      sendmqtt = true
      lt.targetTemp = tt
      lt.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(lt.targetTemp);
      this.log(lt.name+' - set new temperature, target:'+ lt.targetTemp)
    }
    if(sendmqtt){
      if(lt.mqtt_ok == true){
        let msg = sprintf('%d;%d;%d', lt.targetTemp*100, lt.ecoTemp*100, lt.currentTemp*100)
        lt.mqttclient.publish('/house/climate/temperatures', msg, function (err) {
            if (!err) {
                //console.log('Mqtt send')
            }
        })
      }
    }
  }
};

// switch accessory to enable/disable cube connection
function MaxCubeLinkSwitchAccessory(log, config, cubePlatform){
  this.log = log;
  this.config = config;
  this.cubePlatform = cubePlatform;
  this.name = "Max! Link";
  this.service = new Service.Switch("Max! Link");
  this.service.getCharacteristic(Characteristic.On).value = false;
  this.service.getCharacteristic(Characteristic.On)
      .on('set', this.setConnectionState.bind(this))
      .on('get', this.getConnectionState.bind(this));
}

MaxCubeLinkSwitchAccessory.prototype = {
  getServices: function() {
    var informationService = new Service.AccessoryInformation();
    informationService
    .setCharacteristic(Characteristic.Manufacturer, "EQ-3")
    .setCharacteristic(Characteristic.Model, "Max! Cube")
    return [informationService, this.service];
  },
  setConnectionState: function(state, callback){
    if(state){
      this.cubePlatform.startCube();
    }else{
      this.cubePlatform.stopCube();
    }
    callback(null, state);
  },
  getConnectionState: function(callback){
    callback(null, this.cubePlatform.cube.initialised);
  },
  sendStatus: function(){
    this.service.getCharacteristic(Characteristic.On).updateValue(this.cubePlatform.cube.initialised);
  }
}

// thermostat accessory to for house heating sysytem over mqtt
function MaxCubeHouseThermostatAccessory(log, config, cubePlatform){
  //Service = homebridge.hap.Service;
  //Characteristic = homebridge.hap.Characteristic;
  this.log = log;
  this.config = config;
  this.cubePlatform = cubePlatform;

  this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.CELSIUS;
  this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.HEAT;
  this.targetTemp = 22
  this.currentTemp = 22
  this.ecoTemp = 17
  this.offTemp = 4
  this.maxTemp = 30

  this.informationService = new Service.AccessoryInformation();
  this.informationService
    .setCharacteristic(Characteristic.Manufacturer, 'EQ-3')
    .setCharacteristic(Characteristic.Model, "Seltron DD")
    //.setCharacteristic(Characteristic.SerialNumber, this.device.rf_address)

  this.outTemp = 8.5
  this.sensorOutTemp = new Service.TemperatureSensor("Outside temperature", "Outside")
  this.sensorOutTemp
  .getCharacteristic(Characteristic.CurrentTemperature)
  .on('get', this.getOutTemp.bind(this))

  this.sensorOutTemp
  .getCharacteristic(Characteristic.Name)
  .on('get', this.getOutTempName.bind(this))

  this.ovenTemp = 8.5
  this.sensorOvenTemp = new Service.TemperatureSensor("Oven temperature", "Oven")
  this.sensorOvenTemp
  .getCharacteristic(Characteristic.CurrentTemperature)
  .on('get', this.getOvenTemp.bind(this))

  this.sensorOvenTemp
  .getCharacteristic(Characteristic.Name)
  .on('get', this.getOvenTempName.bind(this))

  this.name = "Seltron";
  this.thermostatService = new Service.Thermostat(this.name);
  this.thermostatService
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .on('get', this.getCurrentHeatingCoolingState.bind(this))
    //.updateValue(this.targetHeatingCoolingState);

  this.thermostatService
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .on('get', this.getTargetHeatingCoolingState.bind(this))
    .on('set', this.setTargetHeatingCoolingState.bind(this))
    //.updateValue(this.targetHeatingCoolingState);

  this.thermostatService
    .getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', this.getCurrentTemperature.bind(this))
    //.updateValue(this.currentTemp);

  this.thermostatService
    .getCharacteristic(Characteristic.TargetTemperature)
    .setProps({
      maxValue: 30,
      minValue: 5,
      minStep: 0.5
    })
    .on('get', this.getTargetTemperature.bind(this))
    .on('set', this.setTargetTemperature.bind(this))
    //.updateValue(this.targetTemp);

  this.thermostatService
    .getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .on('get', this.getTemperatureDisplayUnits.bind(this));

  this.mqtt_ok = false
  let that = this   
  this.mqttclient  = mqtt.connect('mqtt://localhost')
  this.mqttclient.on('connect', function () {
      //mqttclient.subscribe('/house/climate/temperatures', function (err) {
    //if (!err) {
        //client.publsh('presence', 'Hello mqtt')
    that.log("Mqtt broker connected")
    that.mqtt_ok = true
  })
  
  /*this.thermostatService
    .addCharacteristic(new Characteristic.StatusLowBattery())
    .on('get', this.getLowBatteryStatus.bind(this));

  this.thermostatService
    .addCharacteristic(new Characteristic.StatusFault())
    .on('get', this.getErrorStatus.bind(this));
  */

  //this.cube.on('device_list', this.refreshDevice.bind(this));    
}

MaxCubeHouseThermostatAccessory.prototype = {
  getServices: function() {
    return [this.informationService, this.thermostatService, this.sensorOutTemp, this.sensorOvenTemp];
  },
  /*checkHeatingCoolingState: function(){
    let oldCoolingState = this.targetHeatingCoolingState;
    if(this.device.mode == 'MANUAL'){
      let isEco = this.device.setpoint == this.ecoTemp;
      let isOff = this.device.setpoint == this.offTemp;
      if(isOff) this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.OFF;
      else if(isEco) this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.COOL;
      else this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.HEAT;
    }else{
      this.targetHeatingCoolingState = Characteristic.TargetHeatingCoolingState.AUTO;
    }
    //only send change notification when we already computed state once
    if(oldCoolingState !== undefined && oldCoolingState != this.targetHeatingCoolingState){
      this.log(this.name+' - computed new target mode '+this.targetHeatingCoolingState);
      this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this.targetHeatingCoolingState);
      this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.currentHeatingCoolingState());
    }
    return this.targetHeatingCoolingState;
  },*/
  getCurrentHeatingCoolingState: function(callback) {
    //this.checkHeatingCoolingState();
    callback(null, this.targetHeatingCoolingState);
  },
  /*currentHeatingCoolingState: function(){
    if(this.targetHeatingCoolingState == Characteristic.TargetHeatingCoolingState.AUTO){
      return Characteristic.TargetHeatingCoolingState.HEAT;
    }
    else {
      return this.targetHeatingCoolingState;
    }
  },*/
  getTargetHeatingCoolingState: function(callback) {
    //this.checkHeatingCoolingState();
    callback(null, this.targetHeatingCoolingState);
  },
  setTargetHeatingCoolingState: function(value, callback) {
    /*this.lastManualChange = new Date();
    let that = this;
    var targetMode = 'MANUAL';
    var targetTemp = this.device.setpoint;
    this.targetHeatingCoolingState = value;
    if(value == Characteristic.TargetHeatingCoolingState.OFF) {
      targetTemp = this.offTemp;
    }
    else if(value == Characteristic.TargetHeatingCoolingState.HEAT) {
      if(targetTemp == this.offTemp){
        targetTemp = this.comfortTemp;
      }
    }
    else if(value == Characteristic.TargetHeatingCoolingState.COOL) {
      targetTemp = this.ecoTemp;
    }
    else if(value == Characteristic.TargetHeatingCoolingState.AUTO) {
      if(targetTemp == this.offTemp){
        targetTemp = this.comfortTemp;
      }
      targetMode = 'AUTO';
    }
    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(targetTemp);
    this.device.mode = targetMode;
    this.device.setpoint = targetTemp;
    this.checkHeatingCoolingState();
    let errorStatus = that.errorStatus();
    this.cube.getConnection().then(function () {
      if(errorStatus != 0){
        that.log(that.name+' has error state '+ errorStatus + ' - sending error reset to cube');
        that.cube.resetError(that.device.rf_address);
      }
      that.log(that.name+' - setting mode '+targetMode+' at temperature '+targetTemp);
      that.cube.setTemperature(that.device.rf_address, targetTemp, targetMode);
      that.sendFault = false;
    }, function(){that.sendFault = true});*/
    callback(null, this.targetHeatingCoolingState);
  },
  getCurrentTemperature: function(callback) {
    callback(null, this.currentTemp);
  },
  getTargetTemperature: function(callback) {
    callback(null, this.targetTemp);
  },
  getOutTemp: function(callback) {
    callback(null, this.outTemp);
  },
  getOutTempName: function(callback) {
    callback(null, "Outside");
  },
  getOvenTemp: function(callback) {
    callback(null, 62);
  },
  getOvenTempName: function(callback) {
    callback(null, "Oven");
  },

  setTargetTemperature: function(value, callback) {
    /*this.lastManualChange = new Date();
    let that = this;
    this.device.setpoint = value;
    let errorStatus = this.errorStatus();
    if(this.cube) this.cube.getConnection().then(function () {
      if(errorStatus != 0){
        that.log(that.name+' has error state '+ errorStatus + ' - sending error reset to cube');
        that.cube.resetError(that.device.rf_address);
      }
      that.log(that.name+' - setting temperature '+ value);
      that.cube.setTemperature(that.device.rf_address, value, that.device.mode);
      that.sendFault = false;
    }, function(){that.sendFault = true});*/
    callback(null, value);
  },
  getTemperatureDisplayUnits: function(callback) {
    callback(null, this.temperatureDisplayUnits);
  },
}

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  _homebridge = homebridge;
  homebridge.registerPlatform('homebridge-platform-maxcube', 'MaxCubePlatform', MaxCubePlatform);
}
