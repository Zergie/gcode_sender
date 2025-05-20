//
// Custom plugin to measure peaks
//

function findPeaksAndLows(array, minDistance = 1) {
  const result = [];
  let lastX = -minDistance;

  for (let i = 1; i < array.length - 1; i++) {
    if (array[i].y > array[i - 1].y && array[i].y > array[i + 1].y) {
      if (array[i].x - lastX >= minDistance) {
        result.push({ type: 'peak', x: array[i].x, y: array[i].y });
        lastX = array[i].x;
      }
    } else if (array[i].y < array[i - 1].y && array[i].y < array[i + 1].y) {
      if (array[i].x - lastX >= minDistance) {
        result.push({ type: 'low', x: array[i].x, y: array[i].y });
        lastX = array[i].x;
      }
    }
  }

  return result;
}

function movingAverage(array, windowSize) {
  const result = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < array.length; i++) {
    let sum = 0;
    let count = 0;

    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < array.length) {
        sum += array[idx].y;
        count++;
      }
    }

    result.push({ x: array[i].x, y: sum / count });
  }

  return result;
}

function findPeakToPeaks(array, tolerance=1) {
  const result = [];

  for (let i = 2; i < array.length; i++) {
    const signature = Array.from([array[i - 2], array[i - 1], array[i]]).map(x => x.type).join(",");

    if (signature == 'peak,low,peak' && Math.abs(array[i - 2].y - array[i].y) <= tolerance) {
      result.push({
        start: { 
          x: array[i - 2].x,
          y: array[i - 2].y,
        },
        end: {
           x: array[i].x,
           y: array[i].y
        },
        delta:  {
          x: array[i].x - array[i - 2].x,
          y: array[i].y - array[i - 2].y,
        },
        color: 'yellow',
      });
    }
  }

  return result;
}

function groupPeakToPeak(array, windowSize = 1) {
  const groups = [];

  if (array.length > 0) {
    groups.push({ 
      min: array[0].delta.x,
      max: array[0].delta.x,
      items: [array[0]],
    });
  }

  for (let i = 1; i < array.length; i++) {
    const group = groups.find(item => item.min - windowSize <= array[i].delta.x && array[i].delta.x <= item.max + windowSize);
    if (group) {
      group.min = Math.min(group.min, array[i].delta.x);
      group.max = Math.max(group.min, array[i].delta.x);
      group.items.push(array[i]);
    } else {
      groups.push({ 
        min: array[i].delta.x,
        max: array[i].delta.x,
        items: [array[i]],
      });
    }
  }

  const result = [];
  for (let group of groups) {
    const { items } = group;
    const obj = items[items.length - 1];
    obj.count = items.length;
    const sum = Array.from(items).reduce((a, b) => a + b.delta.x, 0);
    obj.text = `${(sum/obj.count || 0).toFixed(1)} s`;
    result.push(obj);
  }

  return result;
}




exports.peaksPlugin = {
  afterDraw: chart => {
    chart.data.datasets
      .filter((dataset, index) => chart.isDatasetVisible(index) && dataset.label.startsWith("Temperature"))
      .sort((a, b) => cmp(a.z, b.z) || cmp(a.label, b.label))
      .map((dataset, _) => {
        const smoothedData = movingAverage(dataset.data, 3);
        const peaksAndLows = findPeaksAndLows(smoothedData, 1);
        const peakToPeaks = findPeakToPeaks(peaksAndLows, 1);
        const grouped = groupPeakToPeak(peakToPeaks, 0.5);
        return grouped;
      })
      .forEach(items => {
        const ctx = chart.ctx;

        ctx.save();
        for (let item of items) {
          const { start, end, color, text } = item;
          const y_point = chart.scales.y.getPixelForValue(start.y);

          ctx.beginPath();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 1;
          ctx.moveTo(chart.scales.x.getPixelForValue(start.x), y_point - 10);
          ctx.lineTo(chart.scales.x.getPixelForValue(end.x), y_point - 10);
          ctx.stroke();

          ctx.textAlign = 'center';
          ctx.font = 'bold 12px Roboto';
          ctx.strokeStyle = 'black';
          ctx.lineWidth = 3;
          const x_center = start.x + (end.x - start.x) / 2;
          ctx.strokeText(text, chart.scales.x.getPixelForValue(x_center), y_point - 15);
          ctx.fillText(text, chart.scales.x.getPixelForValue(x_center), y_point - 15);
        }
        ctx.restore();

      });
  }
};

