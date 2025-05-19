//
// Custom plugin to measure peaks
//

function findPeaksAndLows(data, minDistance = 1) {
  const result = [];
  let lastX = -minDistance;

  for (let i = 1; i < data.length - 1; i++) {
    if (data[i].y > data[i - 1].y && data[i].y > data[i + 1].y) {
      if (data[i].x - lastX >= minDistance) {
        result.push({ type: 'peak', x: data[i].x, y: data[i].y });
        lastX = data[i].x;
      }
    } else if (data[i].y < data[i - 1].y && data[i].y < data[i + 1].y) {
      if (data[i].x - lastX >= minDistance) {
        result.push({ type: 'low', x: data[i].x, y: data[i].y });
        lastX = data[i].x;
      }
    }
  }

  return result;
}

function movingAverage(data, windowSize) {
  const result = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let count = 0;

    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < data.length) {
        sum += data[idx].y;
        count++;
      }
    }

    result.push({ x: data[i].x, y: sum / count });
  }

  return result;
}




exports.peaksPlugin = {
  afterDraw: chart => {
    chart.data.datasets
      .filter((dataset, index) => chart.isDatasetVisible(index) && dataset.label.startsWith("Temperature"))
      .sort((a, b) => cmp(a.z, b.z) || cmp(a.label, b.label))
      .map((dataset, index) => {
        const smoothedData = movingAverage(dataset.data, 3);
        const peaksAndLows = findPeaksAndLows(smoothedData, 1);
        return peaksAndLows;
      })
      .forEach(items => {
        const ctx = chart.ctx;

        ctx.save();

        for (let i = 0; i < items.length; i++) {
          const { type, x, y } = items[i];
          const x_point = chart.scales.x.getPixelForValue(x);
          const y_point = chart.scales.y.getPixelForValue(y);

          // if (type == 'peak') {
          //   ctx.strokeStyle = 'red';
          //   ctx.fillStyle = 'red';
          //   ctx.lineWidth = 1;
          // } else {
          //   ctx.strokeStyle = 'green';
          //   ctx.fillStyle = 'green';
          //   ctx.lineWidth = 1;
          // }

          // ctx.beginPath();
          // ctx.moveTo(x_point - 10, y_point);
          // ctx.lineTo(x_point + 10, y_point);
          // ctx.moveTo(x_point, y_point - 10);
          // ctx.lineTo(x_point, y_point + 10);
          // ctx.stroke();

          if (i >= 2) {
            const signature = Array.from([items[i - 2], items[i - 1], items[i]]).map(x => x.type).join(",");
            let offset = 0;
            if (signature == 'peak,low,peak') {
              offset = -10;
            } else if (signature == 'low,peak,low') {
              offset = 10;
            }

            if (offset != 0) {
              ctx.beginPath();
              ctx.strokeStyle = 'yellow';
              ctx.fillStyle = 'yellow';
              ctx.lineWidth = 1;
              ctx.moveTo(chart.scales.x.getPixelForValue(items[i - 2].x), y_point + offset);
              ctx.lineTo(x_point, y_point + offset);
              ctx.stroke();

              ctx.textAlign = 'center';
              ctx.font = 'bold 12px Roboto';
              ctx.strokeStyle = 'black';
              ctx.lineWidth = 3;
              const text = `${(x - items[i - 2].x).toFixed(1)} s`;

              const x_center = items[i - 2].x + (x - items[i - 2].x) / 2;
              ctx.strokeText(text, chart.scales.x.getPixelForValue(x_center), y_point + (offset < 0 ? -20 : 25));
              ctx.fillText(text, chart.scales.x.getPixelForValue(x_center), y_point + (offset < 0 ? -20 : 25));
            }
          }
        }

        ctx.restore();
      });
  }
};
