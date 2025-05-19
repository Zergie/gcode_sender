// Custom plugin to draw last values
exports.labelsPlugin = {
  afterDraw: chart => {
    chart.data.datasets
      .filter((_, index) => chart.isDatasetVisible(index))
      .sort((a, b) => cmp(a.z, b.z) || cmp(a.label, b.label))
      .forEach(dataset => {
        const ctx = chart.ctx;

        // temp labels at end of line
        const { x, y } = dataset.data[dataset.data.length - 1];
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
        ctx.fillStyle = dataset.borderColor;
        ctx.strokeText(text, x_point, y_point);
        ctx.fillText(text, x_point, y_point);
        ctx.restore();
      });
  }
};
