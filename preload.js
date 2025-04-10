// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.
const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')
const { createIcons, icons } = require('lucide');
const { Chart } = require('chart.js/auto');
const { updateSerialPortList } = require("./updateSerialPortList");
const { dispatchEvent } = require('./dispatchEvent');
const { onerror, console_onerror } = require('./errorHandler');
const autoComplete = require("@tarekraafat/autocomplete.js");

// globals
let startup_time = Date.now();
let terminal_history = [];

// error handling
window.onerror = onerror;
console.error = console_onerror;

// electron-reloader events
window.addEventListener('electron-reloader::before-reload', event => {
  if (window.port != undefined) {
    localStorage.setItem('persistent', JSON.stringify({
      startup : startup_time,
      serialport: {
        path: window.port.settings.path,
        baudRate: window.port.settings.baudRate,
      },
      terminal: {
        history: terminal_history,
      },
      chart: {
        datasets: {
          data: window.tempChart.data.datasets,
          hidden: window.tempChart.data.datasets.map((_, index) => index).filter(index => !window.tempChart.isDatasetVisible(index)),
        }
      }
    }));
    window.port.close();
    window.port = undefined;
  } else {
    try { localStorage.removeItem('persistent'); } catch (_) {}
  }
})
window.addEventListener('electron-reloader::after-reload', event => {
  if (localStorage.getItem('persistent')) {
    const persistent = JSON.parse(localStorage.getItem('persistent'));
    console.log(`Reloaded with ${JSON.stringify(persistent)}`);

    startup_time = persistent.startup
    connect(persistent.serialport.path, persistent.serialport.baudRate);
    terminal_history = persistent.terminal.history;

    // chart
    window.tempChart.data.datasets = persistent.chart.datasets.data;
    Array.from(persistent.chart.datasets.hidden).forEach(index => window.tempChart.setDatasetVisibility(index, false));
  } else {
    console.log('Reloaded without persistent data.');
  }
})

// serialport events
window.addEventListener('serialport:connected', _ => {
  document.getElementById('terminal').checked = true;
});
window.addEventListener('serialport:data', event => {
  const data = event.detail.data;
  let should_print = true;
  let match;

  const regex = /T(?<tool>\d*):(?<temp>-?[0-9.]+)(\s*\/(?<target>[0-9.]+))?\s*(@\d?:(?<power>[0-9.]+))?/gm
  while ((match = regex.exec(data)) !== null) {
    dispatchEvent('serialport:data-temp', {
      Tool : parseInt(match.groups.tool || 0),
      Temp : parseFloat(match.groups.temp || -1),
      Target : parseFloat(match.groups.target || -1),
      Power : parseInt(match.groups.power || -1)
    });
    should_print = false;
  }
  
  // should_print = true;
  if (should_print) {
    const terminal = document.querySelector('#terminal-output').getBoundingClientRect();
    const terminal_bottom = document.querySelector('#terminal-output-bottom').getBoundingClientRect();
    const terminal_bottom_visible = terminal_bottom.y <= terminal.y + terminal.height;

    const el = document.createElement('span');
    el.className = 'terminal-command-received';
    el.innerText = data;
    document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));

    if (terminal_bottom_visible) {
      document.querySelector('#terminal-output-bottom').scrollIntoView();
    }
  }
});

function appendToChart(label, color, x, y, yAxisID) {
  if (y != -1) {
    let dataset = window.tempChart.data.datasets.find(dataset => dataset.label === label);
    if (dataset == undefined) {
      dataset = {
        label: label,
        data: [], 
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointStyle: false,
        fill: false,
        tension: 0.1,
        yAxisID: yAxisID,
      };
      window.tempChart.data.datasets.push(dataset);
    }
    dataset.data.push({ x: x, y: y });

    if (x >= window.tempChart.options.scales.x.max) {
      const diff = Math.round(window.tempChart.options.scales.x.max - window.tempChart.options.scales.x.min);
      window.tempChart.options.scales.x.min = x - diff;
      window.tempChart.options.scales.x.max = x;
    }
  }
}
window.addEventListener('serialport:data-temp', event => {
  const data = event.detail;
  const x = (Date.now() - startup_time) / 1000;

  const reds = ['#ff0000', '#ff1a1a', '#ff3333', '#ff4d4d', '#ff6666', '#ff8080', '#ff9999'];
  const redComplementary = ['#11cde9', '#1ad4e9', '#33dbe9', '#4de2e9', '#66e9e9', '#80f0e9', '#99f7e9'];
  const blues = ['#113fe9', '#1f47dc', '#2d4fcf', '#3a57c1', '#485fb4', '#5667a7', '#646f9a', '#4ca3dd', '#3cb0e6', '#2cbde0', '#1ccad9', '#0cd7d2'];

  appendToChart(
    `Temperature ${data.Tool}`,
    reds[data.Tool],
    x,
    data.Temp,
    'y'
  );

  appendToChart(
    `Target ${data.Tool}`,
    redComplementary[data.Tool],
    x,
    data.Target,
    'y'
  );

  appendToChart(
    `Power ${data.Tool}`,
    blues[data.Tool],
    x,
    data.Power,
    'y1'
  );

  window.tempChart.update();
});
window.addEventListener('serialport:disconnected', _ => {
  updateSerialPortList();
});

// ui events
function connect(port, baudRate) {
  document.getElementById('connect-button').checked = true;
  const portError = document.getElementById('port-error');
  portError.style.animation = "none";
  portError.offsetHeight;
  portError.style.animation = null;

  if (port) {
    console.log(`Connecting to port ${port} with baud rate ${baudRate}`);
    portError.style.visibility = "hidden";
    window.port = new SerialPort({ path: port, baudRate: parseInt(baudRate) });
    window.port.on('error', (error) => {
      alert(`Error: ${error.message}`);
      dispatchEvent('serialport:disconnected', {});
    });

    const parser = window.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (data) => dispatchEvent('serialport:data', { data }));
    
    dispatchEvent('serialport:connected', {});
  } else {
    document.getElementById('port-error').style.visibility = null;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('connect-button').addEventListener('click', () => 
    connect(document.getElementById('port-select').value, document.getElementById('baud-rate').value));
  
  document.getElementById('disconnect-button').addEventListener('click', function () {
    console.log(`Disconnecting from port ${window.port.settings.path}`);
    window.port.close();
    window.port = undefined;
    dispatchEvent('serialport:disconnected', {});
  });
  
  const terminal_input = document.getElementById('terminal-input');
  let terminal_history_index = 0;
  terminal_input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      if (terminal_input.value.length > 0) {
        const el = document.createElement('span');
        el.className = 'terminal-command-sent';
        el.innerText = terminal_input.value;
        document.querySelector('#terminal-output').insertBefore(el, document.querySelector('#terminal-output-bottom'));
        document.querySelector('#terminal-output-bottom').scrollIntoView();
        window.port.write(terminal_input.value + '\n');
        terminal_history.push(terminal_input.value);
        terminal_history_index = 0;
      }
      terminal_input.value = "";
    } else if (event.key === 'ArrowUp' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      terminal_history_index += 1;
      if (terminal_history_index > terminal_history.length) {
        terminal_history_index = terminal_history.length;
      }
      terminal_input.value = terminal_history[terminal_history.length - terminal_history_index];
      terminal_input.selectionStart = terminal_input.value.length;
    } else if (event.key === 'ArrowDown' && !event.shiftKey) {
      event.preventDefault();  // Prevent newline insertion
      terminal_history_index -= 1;
      if (terminal_history_index < 1) {
        terminal_history_index = 1;
      }
      terminal_input.value = terminal_history[terminal_history.length - terminal_history_index];
      terminal_input.selectionStart = terminal_input.value.length;
    }
  });
});

// create chart
window.addEventListener('DOMContentLoaded', () => {;
  const ctx = document.querySelector('#temp-chart canvas');
  window.tempChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [],
    },
    plugins: [{
      afterDraw: chart => {
        chart.data.datasets
          .filter((_, index) => chart.isDatasetVisible(index))
          .forEach(dataset => {
            const i = dataset.data.length - 1;
            const x = dataset.data[i].x;
            const y = dataset.data[i].y;
            
            const ctx = chart.ctx;
            const x_point = chart.scales.x.getPixelForValue(x);
            const y_point = chart.scales[dataset.yAxisID].getPixelForValue(y) - 10;
            const text = window.tempChart.options.scales[dataset.yAxisID].ticks.callback(y.toFixed(1), null, null);

            ctx.save();
            ctx.textAlign = 'center';
            ctx.font = 'bold 12px Roboto';
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 3;
            ctx.strokeText(text, x_point, y_point);
            ctx.fillStyle = dataset.borderColor;
            ctx.fillText(`${text}`, x_point, y_point);
            ctx.restore();
          });
      }
    }],
    options: {
      animation: false,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'left',
        }
      },
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          min: 0,
          max: 300,
          ticks: {
            major: {
              enabled: true
            },
            callback: function(value, index, ticks) {
              let time = new Date(value * 1000);
              time = {
                hours: `${time.getHours()-1}`.padStart(2, "0"),
                minutes: `${time.getMinutes()}`.padStart(2, "0"),
                seconds: `${time.getSeconds()}`.padStart(2, "0"),
              }
              return `${time.hours}:${time.minutes}:${time.seconds}`;
            } 
          }
        },
        y: {
          type: 'linear',
          position: 'right',
          suggestedMin: 0,
          suggestedMax: 300,
          ticks: {
            callback: (value, index, ticks) => `${value} ºC`
          }
        },
        y1: {
          type: 'linear',
          position: 'left',
          min: 0,
          max: 255,
          ticks: {
            callback: (value, index, ticks) => `${parseFloat(value).toFixed(0)}`
          }
        }
      }
    }
  });
});

// trigger custom events
window.addEventListener('DOMContentLoaded', () => {
  if (window.port == undefined) {
    dispatchEvent('serialport:disconnected', {});
  } else {
    dispatchEvent('serialport:connected', {});
  }
});

// create menu
window.addEventListener('DOMContentLoaded', () => {
  const autoCompleteJS = new autoComplete({
      selector: "#terminal-input",
      data: {
          // src: ["G000","G001","G002","G003","G004","G005","G006","G010","G011","G012","G017","G019","G020","G021","G026","G027","G028","G029","G030","G031","G032","G033","G034","G035","G038","G042","G053","G054","G059","G060","G061","G076","G080","G090","G091","G092","G425","M000","M001","M003","M004","M005","M007","M009","M010","M011","M016","M017","M018","M020","M021","M022","M023","M024","M025","M026","M027","M028","M029","M030","M031","M032","M033","M034","M042","M043","M048","M073","M075","M076","M077","M078","M080","M081","M082","M083","M085","M086","M087","M092","M100","M102","M104","M105","M106","M107","M108","M109","M110","M111","M112","M113","M114","M115","M117","M118","M119","M120","M121","M122","M123","M125","M126","M127","M128","M129","M140","M141","M143","M145","M149","M150","M154","M155","M163","M164","M165","M166","M190","M191","M192","M193","M200","M201","M203","M204","M205","M206","M207","M208","M209","M210","M211","M217","M218","M220","M221","M226","M240","M250","M255","M256","M260","M261","M280","M281","M282","M290","M300","M301","M302","M303","M304","M305","M306","M350","M351","M355","M360","M361","M362","M363","M364","M380","M381","M400","M401","M402","M403","M404","M405","M406","M407","M410","M412","M413","M420","M421","M422","M423","M425","M428","M430","M486","M493","M500","M501","M502","M503","M504","M510","M511","M512","M524","M540","M569","M575","M592","M593","M600","M603","M605","M665","M666","M672","M701","M702","M710","M7219","M808","M810","M819","M820","M851","M852","M860","M869","M871","M876","M900","M906","M907","M908","M909","M910","M911","M912","M913","M914","M915","M916","M917","M918","M919","M928","M951","M993","M994","M995","M997","M999"],
          src: (query) => {
            const data = [
              {"code":"G0","description":"Move"},
              {"code":"G1","description":"Move"},
              {"code":"G2","description":"Controlled Arc Move"},
              {"code":"G3","description":"Controlled Arc Move"},
              {"code":"G4","description":"Dwell"},
              {"code":"G6","description":"External Motion Control (Marlin)"},
              {"code":"G6","description":"Direct Stepper Move (Druid)"},
              {"code":"G10","description":"Set tool Offset and/or workplace coordinates and/or tool temperatures"},
              {"code":"G10","description":"Retract"},
              {"code":"G11","description":"Unretract"},
              {"code":"G12","description":"Clean Tool"},
              {"code":"G17","description":"Plane Selection (CNC specific)"},
              {"code":"G18","description":"Plane Selection (CNC specific)"},
              {"code":"G19","description":"Plane Selection (CNC specific)"},
              {"code":"G20","description":"Set Units to Inches"},
              {"code":"G21","description":"Set Units to Millimeters"},
              {"code":"G22","description":"Firmware Retract"},
              {"code":"G23","description":"Firmware Recover"},
              {"code":"G26","description":"Mesh Validation Pattern"},
              {"code":"G27","description":"Park toolhead"},
              {"code":"G28","description":"Move to Origin (Home)"},
              {"code":"G29","description":"Detailed Z-Probe"},
              {"code":"G29.1","description":"Set Z probe head offset"},
              {"code":"G29.2","description":"Set Z probe head offset calculated from toolhead position"},
              {"code":"G30","description":"Single Z-Probe"},
              {"code":"G31","description":"Set or Report Current Probe status"},
              {"code":"G31","description":"Dock Z Probe sled"},
              {"code":"G32","description":"Probe Z and calculate Z plane"},
              {"code":"G32","description":"Undock Z Probe sled"},
              {"code":"G33","description":"Firmware dependent"},
              {"code":"G33","description":"Measure/List/Adjust Distortion Matrix (Repetier - Redeem)"},
              {"code":"G33","description":"Delta Auto Calibration (Marlin 1.1.x - MK4duo)"},
              {"code":"G34","description":"Z Stepper Auto-Align"},
              {"code":"G34","description":"Calculate Delta Height from toolhead position (DELTA)"},
              {"code":"G40","description":"Compensation Off (CNC specific)"},
              {"code":"G42","description":"Move to Grid Point"},
              {"code":"G53","description":"Coordinate System Select (CNC specific)"},
              {"code":"G54","description":"Coordinate System Select (CNC specific)"},
              {"code":"G55","description":"Coordinate System Select (CNC specific)"},
              {"code":"G56","description":"Coordinate System Select (CNC specific)"},
              {"code":"G57","description":"Coordinate System Select (CNC specific)"},
              {"code":"G58","description":"Coordinate System Select (CNC specific)"},
              {"code":"G59","description":"Coordinate System Select (CNC specific)"},
              {"code":"G60","description":"Save / Restore position"},
              {"code":"G61","description":"Restore saved position"},
              {"code":"G68","description":"Coordinate rotation"},
              {"code":"G69","description":"Cancel coordinate rotation"},
              {"code":"G75","description":"Print temperature interpolation"},
              {"code":"G76","description":"PINDA probe temperature calibration"},
              {"code":"G80","description":"Cancel Canned Cycle (CNC specific)"},
              {"code":"G80","description":"Mesh-based Z probe"},
              {"code":"G81","description":"Mesh bed leveling status"},
              {"code":"G82","description":"Single Z probe at current location"},
              {"code":"G83","description":"Babystep in Z and store to EEPROM"},
              {"code":"G84","description":"UNDO Babystep Z (move Z axis back)"},
              {"code":"G85","description":"Pick best babystep"},
              {"code":"G86","description":"Disable babystep correction after home"},
              {"code":"G87","description":"Enable babystep correction after home"},
              {"code":"G88","description":"Reserved"},
              {"code":"G90","description":"Set to Absolute Positioning"},
              {"code":"G91","description":"Set to Relative Positioning"},
              {"code":"G92","description":"Set origin offsets"},
              {"code":"G92.1","description":"Reset origin offsets"},
              {"code":"G92.2","description":"Suspend origin offsets"},
              {"code":"G92.3","description":"Resume origin offsets"},
              {"code":"G93","description":"Feed Rate Mode (Inverse Time Mode) (CNC specific)"},
              {"code":"G94","description":"Feed Rate Mode (Units per Minute) (CNC specific)"},
              {"code":"G98","description":"Activate farm mode"},
              {"code":"G99","description":"Deactivate farm mode"},
              {"code":"G100","description":"Calibrate floor or rod radius"},
              {"code":"G130","description":"Set digital potentiometer value"},
              {"code":"G131","description":"Remove offset"},
              {"code":"G132","description":"Calibrate endstop offsets"},
              {"code":"G133","description":"Measure steps to top"},
              {"code":"G161","description":"Home axes to minimum"},
              {"code":"G162","description":"Home axes to maximum"},
              {"code":"G425","description":"Perform auto-calibration with calibration cube"},
              {"code":"M0","description":"Stop or Unconditional stop"},
              {"code":"M1","description":"Sleep or Conditional stop"},
              {"code":"M2","description":"Program End"},
              {"code":"M3","description":"Spindle On, Clockwise  (CNC specific)"},
              {"code":"M4","description":"Spindle On, Counter-Clockwise (CNC specific)"},
              {"code":"M5","description":"Spindle Off (CNC specific)"},
              {"code":"M6","description":"Tool change"},
              {"code":"M7","description":"Mist Coolant On (CNC specific)"},
              {"code":"M8","description":"Flood Coolant On (CNC specific)"},
              {"code":"M9","description":"Coolant Off (CNC specific)"},
              {"code":"M10","description":"Vacuum On (CNC specific)"},
              {"code":"M11","description":"Vacuum Off (CNC specific)"},
              {"code":"M13","description":"Spindle on (clockwise rotation) and coolant on (flood)"},
              {"code":"M16","description":"Expected Printer Check"},
              {"code":"M17","description":"Enable/Power all stepper motors"},
              {"code":"M18","description":"Disable all stepper motors"},
              {"code":"M20","description":"List SD card"},
              {"code":"M21","description":"Initialize SD card"},
              {"code":"M22","description":"Release SD card"},
              {"code":"M23","description":"Select SD file"},
              {"code":"M24","description":"Start/resume SD print"},
              {"code":"M25","description":"Pause SD print"},
              {"code":"M26","description":"Set SD position"},
              {"code":"M27","description":"Report SD print status"},
              {"code":"M28","description":"Begin write to SD card"},
              {"code":"M29","description":"Stop writing to SD card"},
              {"code":"M30","description":"Delete a file on the SD card"},
              {"code":"M30","description":"Program Stop"},
              {"code":"M31","description":"Output time since last "},
              {"code":"M32","description":"Select file and start SD print"},
              {"code":"M33","description":"Get the long name for an SD card file or folder"},
              {"code":"M33","description":"Stop and Close File and save restart.gcode"},
              {"code":"M34","description":"Set SD file sorting options"},
              {"code":"M35","description":"Upload firmware NEXTION from SD"},
              {"code":"M36","description":"Return file information"},
              {"code":"M36.1","description":"Return embedded thumbnail data"},
              {"code":"M37","description":"Simulation mode"},
              {"code":"M40","description":"Eject"},
              {"code":"M41","description":"Loop"},
              {"code":"M42","description":"Switch I/O pin"},
              {"code":"M43","description":"Stand by on material exhausted"},
              {"code":"M43","description":"Pin report and debug"},
              {"code":"M44","description":"Codes debug - report codes available"},
              {"code":"M44","description":"Reset the bed skew and offset calibration"},
              {"code":"M45","description":"Bed skew and offset with manual Z up"},
              {"code":"M46","description":"Show the assigned IP address"},
              {"code":"M47","description":"Show end stops dialog on the display"},
              {"code":"M48","description":"Measure Z-Probe repeatability"},
              {"code":"M49","description":"Set G26 debug flag"},
              {"code":"M70","description":"Display message"},
              {"code":"M72","description":"Firmware dependent"},
              {"code":"M72","description":"Play a tone or song"},
              {"code":"M72","description":"Set/get Printer State"},
              {"code":"M73","description":"Set/Get build percentage"},
              {"code":"M74","description":"Set weight on print bed"},
              {"code":"M75","description":"Start the print job timer"},
              {"code":"M76","description":"Pause the print job timer"},
              {"code":"M77","description":"Stop the print job timer"},
              {"code":"M78","description":"Show statistical information about the print jobs"},
              {"code":"M79","description":"Start host timer"},
              {"code":"M80","description":"ATX Power On"},
              {"code":"M81","description":"ATX Power Off"},
              {"code":"M82","description":"Set extruder to absolute mode"},
              {"code":"M83","description":"Set extruder to relative mode"},
              {"code":"M84","description":"Stop idle hold"},
              {"code":"M85","description":"Set Inactivity Shutdown Timer"},
              {"code":"M86","description":"Set Safety Timeout"},
              {"code":"M87","description":"Cancel Safety Timer"},
              {"code":"M92","description":"Set axis_steps_per_unit"},
              {"code":"M93","description":"Send axis_steps_per_unit"},
              {"code":"M98","description":"Call Macro/Subprogram"},
              {"code":"M99","description":"Return from Macro/Subprogram"},
              {"code":"M101","description":"Turn extruder 1 on (Forward), Undo Retraction"},
              {"code":"M102","description":"Turn extruder 1 on (Reverse)"},
              {"code":"M102","description":"Configure Distance Sensor"},
              {"code":"M103","description":"Turn all extruders off, Extruder Retraction"},
              {"code":"M104","description":"Set Extruder Temperature"},
              {"code":"M105","description":"Get Extruder Temperature"},
              {"code":"M106","description":"Fan On"},
              {"code":"M107","description":"Fan Off"},
              {"code":"M108","description":"Cancel Heating"},
              {"code":"M108","description":"Set Extruder Speed (BFB)"},
              {"code":"M109","description":"Set Extruder Temperature and Wait"},
              {"code":"M110","description":"Set Current Line Number"},
              {"code":"M111","description":"Set Debug Level"},
              {"code":"M112","description":"Full (Emergency) Stop"},
              {"code":"M113","description":"Set Extruder PWM"},
              {"code":"M113","description":"Host Keepalive"},
              {"code":"M114","description":"Get Current Position"},
              {"code":"M115","description":"Get Firmware Version and Capabilities"},
              {"code":"M116","description":"Wait"},
              {"code":"M117","description":"Get Zero Position"},
              {"code":"M117","description":"Display Message"},
              {"code":"M118","description":"Echo message on host"},
              {"code":"M118","description":"Negotiate Features"},
              {"code":"M119","description":"Get Endstop Status"},
              {"code":"M120","description":"Push"},
              {"code":"M121","description":"Pop"},
              {"code":"M120","description":"Enable endstop detection"},
              {"code":"M121","description":"Disable endstop detection"},
              {"code":"M122","description":"Firmware dependent"},
              {"code":"M122","description":"Diagnose (RepRapFirmware)"},
              {"code":"M122","description":"Set Software Endstop (MK4duo)"},
              {"code":"M122","description":"Debug Stepper drivers (Marlin)"},
              {"code":"M123","description":"Firmware dependent"},
              {"code":"M123","description":"Tachometer value (RepRap, Prusa &amp; Marlin)"},
              {"code":"M123","description":"Endstop Logic (MK4duo)"},
              {"code":"M124","description":"Firmware dependent"},
              {"code":"M124","description":"Immediate motor stop"},
              {"code":"M124","description":"Set Endstop Pullup"},
              {"code":"M125","description":"Firmware dependent"},
              {"code":"M125","description":"Park Head"},
              {"code":"M125","description":"Pause print"},
              {"code":"M126","description":"Open Valve"},
              {"code":"M127","description":"Close Valve"},
              {"code":"M128","description":"Extruder Pressure PWM"},
              {"code":"M129","description":"Extruder pressure off"},
              {"code":"M130","description":"Set PID P value"},
              {"code":"M131","description":"Set PID I value"},
              {"code":"M132","description":"Set PID D value"},
              {"code":"M133","description":"Set PID I limit value"},
              {"code":"M134","description":"Write PID values to EEPROM"},
              {"code":"M135","description":"Set PID sample interval"},
              {"code":"M136","description":"Print PID settings to host"},
              {"code":"M140","description":"Set Bed Temperature (Fast)"},
              {"code":"M141","description":"Set Chamber Temperature (Fast)"},
              {"code":"M142","description":"Firmware dependent"},
              {"code":"M142","description":"Holding Pressure"},
              {"code":"M142","description":"Set Cooler Temperature (Fast)"},
              {"code":"M143","description":"Firmware dependent"},
              {"code":"M143","description":"Set Laser Cooler Temperature (Fast)"},
              {"code":"M143","description":"Maximum heater temperature"},
              {"code":"M144","description":"Bed Standby"},
              {"code":"M146","description":"Set Chamber Humidity"},
              {"code":"M149","description":"Set temperature units"},
              {"code":"M150","description":"Set LED color"},
              {"code":"M154","description":"Auto Report Position"},
              {"code":"M155","description":"Automatically send temperatures"},
              {"code":"M160","description":"Number of mixed materials"},
              {"code":"M163","description":"Set weight of mixed material"},
              {"code":"M164","description":"Store weights"},
              {"code":"M165","description":"Set multiple mix weights"},
              {"code":"M190","description":"Wait for bed temperature to reach target temp"},
              {"code":"M191","description":"Wait for chamber temperature to reach target temp"},
              {"code":"M192","description":"Wait for Probe Temperature"},
              {"code":"M193","description":"Set Laser Cooler Temperature"},
              {"code":"M200","description":"Set filament diameter"},
              {"code":"M201","description":"Set max acceleration"},
              {"code":"M201.1","description":"Set reduced acceleration for special move types"},
              {"code":"M202","description":"Set max travel acceleration"},
              {"code":"M203","description":"Firmware dependent"},
              {"code":"M203","description":"Set maximum feedrate"},
              // {"code":"M203 (Repetier)","description":"Set temperature monitor"},
              {"code":"M204","description":"Firmware dependent"},
              {"code":"M204","description":"Set default acceleration"},
              {"code":"M204","description":"Set PID values"},
              {"code":"M205","description":"Firmware dependent"},
              {"code":"M205","description":"Advanced settings"},
              {"code":"M205","description":"EEPROM Report"},
              {"code":"M206","description":"Firmware dependent"},
              {"code":"M206","description":"Offset axes"},
              {"code":"M206","description":"Set EEPROM value"},
              {"code":"M207","description":"Firmware dependent"},
              {"code":"M207","description":"Set retract length"},
              // {"code":"M207 (Repetier)","description":"Set jerk without saving to EEPROM"},
              {"code":"M208","description":"Firmware dependent"},
              {"code":"M208","description":"Set unretract length"},
              // {"code":"M208 (RepRapFirmware)","description":"Set axis max travel"},
              {"code":"M209","description":"Enable automatic retract"},
              {"code":"M210","description":"Set homing feedrates"},
              {"code":"M211","description":"Disable/Enable software endstops"},
              {"code":"M212","description":"Set Bed Level Sensor Offset"},
              {"code":"M214","description":"Set Arc configuration values"},
              {"code":"M217","description":"Toolchange Parameters"},
              {"code":"M218","description":"Set Hotend Offset"},
              {"code":"M220","description":"Set speed factor override percentage"},
              {"code":"M221","description":"Set extrude factor override percentage"},
              {"code":"M220","description":"Turn off AUX V1.0.5"},
              {"code":"M221","description":"Turn on AUX V1.0.5"},
              {"code":"M222","description":"Set speed of fast XY moves"},
              {"code":"M223","description":"Set speed of fast Z moves"},
              {"code":"M224","description":"Enable extruder during fast moves"},
              {"code":"M225","description":"Disable on extruder during fast moves"},
              {"code":"M226","description":"G-code Initiated Pause"},
              {"code":"M226","description":"Wait for pin state"},
              {"code":"M227","description":"Enable Automatic Reverse and Prime"},
              {"code":"M228","description":"Disable Automatic Reverse and Prime"},
              {"code":"M229","description":"Enable Automatic Reverse and Prime"},
              {"code":"M230","description":"Disable / Enable Wait for Temperature Change"},
              {"code":"M231","description":"Set OPS parameter"},
              {"code":"M232","description":"Read and reset max. advance values"},
              {"code":"M240","description":"Trigger camera"},
              {"code":"M240","description":"Start conveyor belt motor / Echo off"},
              {"code":"M241","description":"Stop conveyor belt motor / echo on"},
              {"code":"M245","description":"Start cooler"},
              {"code":"M246","description":"Stop cooler"},
              {"code":"M250","description":"Set LCD contrast"},
              {"code":"M256","description":"Set LCD brightness"},
              {"code":"M251","description":"Measure Z steps from homing stop (Delta printers)"},
              {"code":"M260","description":"i2c Send Data"},
              {"code":"M260.1","description":"Modbus Write register(s)"},
              {"code":"M261","description":"i2c Request Data"},
              {"code":"M261.1","description":"Modbus Read Input Registers"},
              {"code":"M280","description":"Set servo position"},
              {"code":"M281","description":"Set Servo Angles"},
              {"code":"M282","description":"Detach Servo"},
              {"code":"M290","description":"Babystepping"},
              {"code":"M291","description":"Display message and optionally wait for response"},
              {"code":"M292","description":"Acknowledge message"},
              {"code":"M293","description":"Babystep Z+"},
              {"code":"M294","description":"Babystep Z-"},
              {"code":"M300","description":"Play beep sound"},
              {"code":"M301","description":"Set PID parameters"},
              {"code":"M302","description":"Allow cold extrudes"},
              {"code":"M303","description":"Run PID tuning"},
              {"code":"M304","description":"Set PID parameters - Bed"},
              {"code":"M305","description":"Set thermistor and ADC parameters"},
              {"code":"M306","description":"Set home offset calculated from toolhead position"},
              {"code":"M307","description":"Set or report heating process parameters"},
              {"code":"M308","description":"Set or report sensor parameters"},
              {"code":"M309","description":"Set or report heater feedforward"},
              {"code":"M310","description":"Temperature model settings"},
              {"code":"M320","description":"Activate autolevel (Repetier)"},
              {"code":"M321","description":"Deactivate autolevel (Repetier)"},
              {"code":"M322","description":"Reset autolevel matrix (Repetier)"},
              {"code":"M323","description":"Distortion correction on/off (Repetier)"},
              {"code":"M340","description":"Control the servos"},
              {"code":"M350","description":"Set microstepping mode"},
              {"code":"M351","description":"Toggle MS1 MS2 pins directly"},
              {"code":"M355","description":"Turn case lights on/off"},
              {"code":"M360","description":"Report firmware configuration"},
              {"code":"M360","description":"Move to Theta 0 degree position"},
              {"code":"M361","description":"Move to Theta 90 degree position"},
              {"code":"M362","description":"Move to Psi 0 degree position"},
              {"code":"M363","description":"Move to Psi 90 degree position"},
              {"code":"M364","description":"Move to Psi + Theta 90 degree position"},
              {"code":"M365","description":"SCARA scaling factor"},
              {"code":"M366","description":"SCARA convert trim"},
              {"code":"M370","description":"Morgan manual bed level - clear map"},
              {"code":"M371","description":"Move to next calibration position"},
              {"code":"M372","description":"Record calibration value, and move to next position"},
              {"code":"M373","description":"End bed level calibration mode"},
              {"code":"M374","description":"Save calibration grid"},
              {"code":"M375","description":"Display matrix / Load Matrix"},
              {"code":"M376","description":"Set bed compensation taper"},
              {"code":"M380","description":"Activate solenoid"},
              {"code":"M381","description":"Disable all solenoids"},
              {"code":"M400","description":"Wait for current moves to finish"},
              {"code":"M401","description":"Deploy Z Probe"},
              {"code":"M402","description":"Stow Z Probe"},
              {"code":"M403","description":"Set filament type (material) for particular extruder and notify the MMU"},
              {"code":"M404","description":"Filament diameter"},
              {"code":"M405","description":"Filament Sensor on"},
              {"code":"M406","description":"Filament Sensor off"},
              {"code":"M407","description":"Display filament diameter"},
              {"code":"M408","description":"Report JSON-style response"},
              {"code":"M409","description":"Query object model"},
              {"code":"M410","description":"Quick-Stop"},
              {"code":"M412","description":"Disable Filament Runout Detection"},
              {"code":"M413","description":"Power-Loss Recovery"},
              {"code":"M415","description":"Host Rescue"},
              {"code":"M416","description":"Power loss"},
              {"code":"M420","description":"Firmware dependent"},
              {"code":"M420","description":"Set RGB Colors as PWM (MachineKit)"},
              {"code":"M420","description":"Leveling On/Off/Fade (Marlin)"},
              {"code":"M420","description":"Mesh bed leveling status"},
              {"code":"M421","description":"Set a Mesh Bed Leveling Z coordinate"},
              {"code":"M422","description":"Set a G34 Point"},
              {"code":"M423","description":"X-Axis Twist Compensation"},
              {"code":"M424","description":"Global Z Offset"},
              {"code":"M425","description":"Backlash Correction"},
              {"code":"M450","description":"Report Printer Mode"},
              {"code":"M451","description":"Select FFF Printer Mode"},
              {"code":"M452","description":"Select Laser Printer Mode"},
              {"code":"M453","description":"Select CNC Printer Mode"},
              {"code":"M460","description":"Define temperature range for thermistor-controlled fan"},
              {"code":"M470","description":"Create Directory on SD-Card"},
              {"code":"M471","description":"Rename File/Directory on SD-Card"},
              {"code":"M472","description":"Delete File/Directory on SD-Card"},
              {"code":"M486","description":"Cancel Object"},
              {"code":"M493","description":"Fixed-Time Motion Control"},
              {"code":"M500","description":"Store parameters in non-volatile storage"},
              {"code":"M501","description":"Read parameters from EEPROM"},
              {"code":"M502","description":"Restore Default Settings"},
              {"code":"M503","description":"Report Current Settings"},
              {"code":"M504","description":"Validate EEPROM"},
              {"code":"M505","description":"Firmware dependent"},
              {"code":"M505","description":"Clear EEPROM and RESET Printer"},
              {"code":"M505","description":"Set configuration file folder"},
              {"code":"M505","description":"Set a named EEPROM value"},
              {"code":"M509","description":"Force language selection"},
              {"code":"M510","description":"Lock Machine"},
              {"code":"M511","description":"Unlock Machine with Passcode"},
              {"code":"M512","description":"Set Passcode"},
              {"code":"M513","description":"Remove Password"},
              {"code":"M524","description":"Abort SD Printing"},
              {"code":"M530","description":"Enable printing mode"},
              {"code":"M531","description":"Set print name"},
              {"code":"M532","description":"Set print progress"},
              {"code":"M540","description":"Set MAC address"},
              // {"code":"M540 in Marlin/Druid/MK4duo","description":"Enable/Disable \"Stop SD Print on Endstop Hit\""},
              {"code":"M544","description":"Gcode Parser Options"},
              {"code":"M550","description":"Set Name"},
              {"code":"M551","description":"Set Password"},
              {"code":"M552","description":"Set IP address, enable/disable network interface"},
              {"code":"M553","description":"Set Netmask"},
              {"code":"M554","description":"Set Gateway and/or DNS server"},
              {"code":"M555","description":"Set compatibility"},
              {"code":"M555","description":"Set Bounding Box"},
              {"code":"M556","description":"Axis compensation"},
              {"code":"M557","description":"Set Z probe point or define probing grid"},
              {"code":"M558","description":"Set Z probe type"},
              {"code":"M558.1","description":"Calibrate height vs. reading for analog Z probe"},
              {"code":"M558.2","description":"Set, report or calibrate drive current for analog Z probe"},
              {"code":"M558.3","description":"Set touch mode parameters for analog Z probe"},
              {"code":"M559","description":"Upload configuration file"},
              {"code":"M560","description":"Upload web page file"},
              {"code":"M561","description":"Set Identity Transform"},
              {"code":"M562","description":"Reset temperature fault"},
              {"code":"M563","description":"Define or remove a tool"},
              {"code":"M564","description":"Limit axes"},
              {"code":"M565","description":"Set Z probe offset"},
              {"code":"M566","description":"Set allowable instantaneous speed change"},
              {"code":"M567","description":"Set tool mix ratios"},
              {"code":"M568","description":"Tool settings"},
              {"code":"M568","description":"Turn off/on tool mix ratios (obsolete meaning in old RepRapFirmware versions)"},
              {"code":"M569","description":"Stepper driver control"},
              {"code":"M569.1","description":"Stepper driver closed loop configuration"},
              {"code":"M569.2","description":"Read or write any stepper driver register"},
              {"code":"M569.3","description":"Read Motor Driver Encoder"},
              {"code":"M569.4","description":"Set Motor Driver Torque Mode"},
              {"code":"M569.5","description":"Collect Data from Closed-loop Driver"},
              {"code":"M569.6","description":"Execute Closed-loop Driver Tuning Move"},
              {"code":"M569.7","description":"Configure motor brake port"},
              {"code":"M569.8","description":"Read Axis Force"},
              {"code":"M569.9","description":"Sets the driver sense resistor and maximum current"},
              {"code":"M570","description":"Configure heater fault detection"},
              {"code":"M571","description":"Set output on extrude"},
              {"code":"M572","description":"Set or report extruder pressure advance"},
              {"code":"M573","description":"Report heater PWM"},
              {"code":"M574","description":"Set endstop configuration"},
              {"code":"M575","description":"Set serial comms parameters"},
              {"code":"M576","description":"Set SPI comms parameters"},
              {"code":"M577","description":"Wait until endstop is triggered"},
              {"code":"M578","description":"Fire inkjet bits"},
              {"code":"M579","description":"Scale Cartesian axes"},
              {"code":"M580","description":"Select Roland"},
              {"code":"M581","description":"Configure external trigger"},
              {"code":"M582","description":"Check external trigger"},
              {"code":"M584","description":"Set drive mapping"},
              {"code":"M585","description":"Probe Tool"},
              {"code":"M586","description":"Configure network protocols"},
              {"code":"M586.4","description":"Configure MQTT server"},
              {"code":"M587","description":"Store WiFi host network in list, or list stored networks"},
              {"code":"M588","description":"Forget WiFi host network"},
              {"code":"M589","description":"Configure access point parameters"},
              {"code":"M590","description":"Report current tool type and index"},
              {"code":"M591","description":"Configure filament monitoring"},
              {"code":"M592","description":"Configure nonlinear extrusion"},
              {"code":"M593","description":"Configure Input Shaping"},
              {"code":"M594","description":"Enter/Leave Height Following mode"},
              {"code":"M595","description":"Set movement queue length"},
              {"code":"M596","description":"Select movement queue number"},
              {"code":"M597","description":"Collision avoidance"},
              {"code":"M598","description":"Sync motion systems"},
              {"code":"M599","description":"Define keepout zone"},
              {"code":"M600","description":"Set line cross section"},
              {"code":"M600","description":"Filament change pause"},
              {"code":"M601","description":"Pause print"},
              {"code":"M602","description":"Resume print"},
              {"code":"M603","description":"Stop print (Prusa i3)"},
              {"code":"M603","description":"Configure Filament Change"},
              {"code":"M605","description":"Set dual x-carriage movement mode"},
              {"code":"M606","description":"Fork input file reader"},
              {"code":"M650","description":"Set peel move parameters"},
              {"code":"M651","description":"Execute peel move"},
              {"code":"M655","description":"Send request to custom CAN-connected expansion board"},
              {"code":"M665","description":"Set delta configuration"},
              {"code":"M666","description":"Set delta endstop adjustment"},
              {"code":"M667","description":"Select CoreXY mode"},
              {"code":"M668","description":"Set Z-offset compensations polynomial"},
              {"code":"M669","description":"Set kinematics type and kinematics parameters"},
              {"code":"M670","description":"Set IO port bit mapping"},
              {"code":"M671","description":"Define positions of Z leadscrews or bed leveling screws"},
              {"code":"M672","description":"Program Z probe"},
              {"code":"M673","description":"Align plane on rotary axis"},
              {"code":"M674","description":"Set Z to center point"},
              {"code":"M675","description":"Find center of cavity"},
              {"code":"M700","description":"Level plate"},
              {"code":"M701","description":"Load filament"},
              {"code":"M702","description":"Unload filament"},
              {"code":"M703","description":"Configure Filament"},
              {"code":"M704","description":"Preload_to_MMU"},
              {"code":"M705","description":"Eject filament"},
              {"code":"M706","description":"Cut filament"},
              {"code":"M707","description":"Read from MMU register"},
              {"code":"M708","description":"Write to MMU register"},
              {"code":"M709","description":"MMU power &amp; reset"},
              {"code":"M710","description":"Firmware dependent"},
              {"code":"M710","description":"Controller Fan settings"},
              {"code":"M710","description":"Erase the EEPROM and reset the board"},
              {"code":"M711","description":"Calibrate pressure advance"},
              {"code":"M750","description":"Enable 3D scanner extension"},
              {"code":"M751","description":"Register 3D scanner extension over USB"},
              {"code":"M752","description":"Start 3D scan"},
              {"code":"M753","description":"Cancel current 3D scanner action"},
              {"code":"M754","description":"Calibrate 3D scanner"},
              {"code":"M755","description":"Set alignment mode for 3D scanner"},
              {"code":"M756","description":"Shutdown 3D scanner"},
              {"code":"M800","description":"Fire start print procedure"},
              {"code":"M801","description":"Fire end print procedure"},
              {"code":"M808","description":"Set or Goto Repeat Marker"},
              {"code":"M810","description":"Temporary G-code macros"},
              {"code":"M811","description":"Temporary G-code macros"},
              {"code":"M812","description":"Temporary G-code macros"},
              {"code":"M813","description":"Temporary G-code macros"},
              {"code":"M814","description":"Temporary G-code macros"},
              {"code":"M815","description":"Temporary G-code macros"},
              {"code":"M816","description":"Temporary G-code macros"},
              {"code":"M817","description":"Temporary G-code macros"},
              {"code":"M818","description":"Temporary G-code macros"},
              {"code":"M819","description":"Temporary G-code macros"},
              {"code":"M820","description":"Report Temporary G-code macros"},
              {"code":"M850","description":"Sheet parameters"},
              {"code":"M851","description":"Set Z-Probe Offset"},
              {"code":"M862","description":"Print checking"},
              {"code":"M862.1","description":"Check nozzle diameter"},
              {"code":"M862.2","description":"Check model code"},
              {"code":"M862.3","description":"Model name"},
              {"code":"M862.4","description":"Firmware version"},
              {"code":"M862.5","description":"Gcode level"},
              {"code":"M862.6","description":"Firmware features"},
              {"code":"M871","description":"PTC Configuration"},
              {"code":"M876","description":"Dialog handling"},
              {"code":"M900","description":"Set Linear Advance Scaling Factors"},
              {"code":"M905","description":"Set local date and time"},
              {"code":"M906","description":"Set motor currents"},
              {"code":"M907","description":"Set digital trimpot motor current"},
              {"code":"M908","description":"Control digital trimpot directly"},
              {"code":"M909","description":"Set microstepping"},
              {"code":"M910","description":"Set decay mode"},
              {"code":"M910","description":"TMC2130 init"},
              {"code":"M911","description":"Configure auto save on loss of power (\"power panic\")"},
              {"code":"M911","description":"Set TMC2130 holding currents"},
              {"code":"M911","description":"Report TMC Overtemperature Pre-Warn"},
              {"code":"M912","description":"Set electronics temperature monitor adjustment"},
              {"code":"M912","description":"Set TMC2130 running currents"},
              {"code":"M912","description":"Clear TMC Overtemperature Pre-Warn"},
              {"code":"M913","description":"Set motor percentage of normal current"},
              {"code":"M913","description":"Set Hybrid (PWM) Threshold"},
              {"code":"M913","description":"Print TMC2130 currents"},
              {"code":"M914","description":"Set/Get Expansion Voltage Level Translator"},
              {"code":"M914","description":"Set TMC2130 normal mode"},
              {"code":"M914","description":"Set StallGuard sensitivity (Homing Threshold)"},
              {"code":"M915","description":"Configure motor stall detection"},
              {"code":"M915","description":"Set TMC2130 silent mode"},
              {"code":"M916","description":"Resume print after power failure"},
              {"code":"M916","description":"Set TMC2130 Stallguard sensitivity threshold"},
              {"code":"M917","description":"Set motor standstill current reduction"},
              {"code":"M917","description":"Set TMC2130 PWM amplitude offset (pwm_ampl)"},
              {"code":"M918","description":"Configure direct-connect display"},
              {"code":"M918","description":"Set TMC2130 PWM amplitude gradient (pwm_grad)"},
              {"code":"M919","description":"TMC Chopper Time"},
              {"code":"M920","description":"TMC Homing Current"},
              {"code":"M928","description":"Start SD logging"},
              {"code":"M929","description":"Start/stop event logging to SD card"},
              {"code":"M950","description":"Create heater, fan or GPIO/servo device"},
              {"code":"M951","description":"Set height following mode parameters"},
              {"code":"M952","description":"Set CAN expansion board address and/or normal data rate"},
              {"code":"M953","description":"Set CAN-FD bus fast data rate"},
              {"code":"M954","description":"Configure as CAN expansion board"},
              {"code":"M955","description":"Configure Accelerometer"},
              {"code":"M956","description":"Collect accelerometer data and write to file"},
              {"code":"M957","description":"Raise event"},
              {"code":"M958","description":"Excite harmonic vibration"},
              {"code":"M970","description":"Enable/Disable Phase Stepping"},
              {"code":"M970.1","description":"Configure Phase Stepping Velocity Constant"},
              {"code":"M970.2","description":"Configure Phase Stepping Acceleration Constant"},
              {"code":"M972","description":"Retrieve Current Correction"},
              {"code":"M973","description":"Set Single Entry in Current Correction Table"},
              {"code":"M974","description":"Measure Print Head Resonance"},
              {"code":"M975","description":"Measure Dwarf Accelerometer Sampling Frequency"},
              {"code":"M976","description":"Measure Print Head Resonance"},
              {"code":"M977","description":"Calibrate Motor"},
              {"code":"M995","description":"Calibrate Touch Screen"},
              {"code":"M997","description":"Perform in-application firmware update"},
              {"code":"M998","description":"Request resend of line"},
              {"code":"M999","description":"Restart after being stopped by error"},
              // {"code":"G","description":"List all G-codes"},
              // {"code":"M","description":"List all M-codes"},
              // {"code":"T","description":"Select Tool"},
              // {"code":"D","description":"Debug codes"},
              // {"code":"D-1","description":"Endless Loop"},
              {"code":"D0","description":"Reset"},
              {"code":"D1","description":"Clear EEPROM and RESET"},
              {"code":"D2","description":"Read/Write RAM"},
              {"code":"D3","description":"Read/Write EEPROM"},
              {"code":"D4","description":"Read/Write PIN"},
              {"code":"D5","description":"Read/Write FLASH"},
              {"code":"D6","description":"Read/Write external FLASH"},
              {"code":"D7","description":"Read/Write Bootloader"},
              {"code":"D8","description":"Read/Write PINDA"},
              {"code":"D9","description":"Read/Write ADC"},
              {"code":"D10","description":"Set XYZ calibration = OK"},
              {"code":"D12","description":"Time"},
              {"code":"D20","description":"Generate an offline crash dump"},
              {"code":"D21","description":"Print crash dump to serial"},
              {"code":"D22","description":"Clear crash dump state"},
              {"code":"D23","description":"Request emergency dump on serial"},
              {"code":"D80","description":"Bed check"},
              {"code":"D81","description":"Bed analysis"},
              {"code":"D106","description":"Print measured fan speed for different pwm values"},
              {"code":"D2130","description":"Trinamic stepper controller"},
              {"code":"D9125","description":"PAT9125 filament sensor"}
            ];
            return Array.from(data).filter(x => x.code.toLowerCase().startsWith(query.toLowerCase())).map(x => `${x.code} - ${x.description}`);
          },
      },
      resultItem: {
          highlight: true
      },
      events: {
          input: {
              selection: (event) => {
                  const selection = event.detail.selection.value;
                  autoCompleteJS.input.value = selection.split(" - ")[0]; 
              }
          }
      }
  });
});
window.addEventListener('DOMContentLoaded', () => {
  let menuItems = Array.from(document.querySelectorAll('.container .text-content .text'))
  const content = document.querySelector('.container .content');
  const list = document.querySelector('.container .content .list');
  let count = 0;
  
  menuItems.forEach(item => {
    const input = document.createElement('input');
    input.setAttribute('type', 'radio');
    input.setAttribute('name', 'slider');
    input.setAttribute('id', item.classList[0]);
    if (count === 0) {
      input.setAttribute('checked', '');
    }
    content.insertBefore(input, list);
    
    count++;
  });
  menuItems.forEach(item => {
    const label = document.createElement('label');
    label.setAttribute('for', item.classList[0]);
    label.classList.add(item.classList[0]);
    const span = document.createElement('div');
    span.setAttribute('data-lucide', item.getAttribute('icon'));
    label.appendChild(span);
    list.appendChild(label);
  });

  menuItems = menuItems.map(x => x.classList[0])
  const style = document.querySelector('#style');
  style.innerHTML = `
  ${menuItems.map(x => `#${x}:checked~.list label.${x}`).join(',')}{
    color: var(--checked-color);
    background-color: var(--checked-background);
    transition: all 0.6s ease;
  }
  ${menuItems.map(x => `#${x}:checked~.text-content .${x}`).join(',')}{
    display: block;
  }
  ${menuItems.slice(1).map(x => `#${x}:checked~.text-content .${menuItems[0]}`).join(',')}{
    display: none;
  }
  `;
});
window.addEventListener('DOMContentLoaded', () => {
  createIcons({ icons });
});

// fill in the program name, version, description, and URL from package.json
window.addEventListener('DOMContentLoaded', () => {
  fetch('./package.json')
  .then(response => response.json())
  .then(package => {
    document.title = `${package.name} v${package.version}`;
    Array.from(document.querySelectorAll('.program-name')).forEach(node => node.innerText = package.name);
    Array.from(document.querySelectorAll('.program-version')).forEach(node => node.innerText = package.version);
    Array.from(document.querySelectorAll('.program-description')).forEach(node => node.innerText = package.description);
    Array.from(document.querySelectorAll('a.program-url')).forEach(node => { 
      node.innerText = package.homepage;
      node.href = package.homepage;
    });
  })
  .catch(error => console.error('Error loading package.json:', error));
});