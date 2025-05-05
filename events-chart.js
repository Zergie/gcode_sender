const { Chart } = require('chart.js/auto');

let startup_time = Date.now();

require('./storage.js').register(__filename, {
  on_save: function (callback) {
    const session = {
      startup : startup_time,
    };
    if (window.tempChart) {
      session.datasets = chart_datasets;
      session.hidden_datasets = chart_datasets.map((_, index) => index).filter(index => !window.tempChart.isDatasetVisible(index));
    };
    const localData = {};

    callback(session, localData);
  },
  on_load: function (session, localData) {
    startup_time = session.startup_time || Date.now();
    if (window.tempChart) {
      window.tempChart.datasets = session.datasets || [];
      Array.from(session.hidden_datasets || []).forEach(index => window.tempChart.setDatasetVisibility(index, false));
    }
  },
});

window.addEventListener('serialport:data-temp', event => {
  const data = event.detail;
  const x = (Date.now() - startup_time) / 1000;
  const reds = ['#ff0000', '#ff1a1a', '#ff3333', '#ff4d4d', '#ff6666', '#ff8080', '#ff9999'];
  const redComplementary = ['#11cde9', '#1ad4e9', '#33dbe9', '#4de2e9', '#66e9e9', '#80f0e9', '#99f7e9'];
  const blues = ['#113fe9', '#1f47dc', '#2d4fcf', '#3a57c1', '#485fb4', '#5667a7', '#646f9a', '#4ca3dd', '#3cb0e6', '#2cbde0', '#1ccad9', '#0cd7d2'];

  appendToChart( `Temperature ${data.Tool}`, reds[data.Tool], x, data.Temp, 'y', 10 );
  appendToChart( `Target ${data.Tool}`, redComplementary[data.Tool], x, data.Target, 'y', 1 );
  appendToChart( `Power ${data.Tool}`, blues[data.Tool], x, data.Power, 'y1', 2 );

  window.tempChart.update();
});


// create chart
cmp = function (a, b) {
  if (a > b) return +1;
  if (a < b) return -1;
  return 0;
};

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
        .sort((a, b) => cmp(a.z, b.z) || cmp(a.label, b.label))
        .forEach(dataset => {
          const i = dataset.data.length - 1;
          const x = dataset.data[i].x;
          const y = dataset.data[i].y;

          const ctx = chart.ctx;
          const x_point = chart.scales.x.getPixelForValue(x);
          let y_point = chart.scales[dataset.yAxisID].getPixelForValue(y);
          const text = window.tempChart.options.scales[dataset.yAxisID].ticks.callback(y.toFixed(1), null, null);

          if (y_point > ctx.canvas.height / 2) {
            y_point -= 10;
          } else {
            y_point += 10;
          }

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
          callback: function (value, index, ticks) {
            let time = new Date(value * 1000);
            time = {
              hours: `${time.getHours() - 1}`.padStart(2, "0"),
              minutes: `${time.getMinutes()}`.padStart(2, "0"),
              seconds: `${time.getSeconds()}`.padStart(2, "0"),
            };
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

function appendToChart(label, color, x, y, yAxisID, z) {
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
        z: z,
      };
      window.tempChart.data.datasets.push(dataset);
    }
    dataset.data.push({ x: x, y: y });

    if (x >= window.tempChart.options.scales.x.max) {
      const diff = Math.round(window.tempChart.options.scales.x.max - window.tempChart.options.scales.x.min);
      window.tempChart.options.scales.x.min = x - diff;
      window.tempChart.options.scales.x.max = x;
    }

    // Remove data points that are less than scales.x.min
    dataset.data = dataset.data.filter(point => point.x + 10 > window.tempChart.options.scales.x.min);
  }
}