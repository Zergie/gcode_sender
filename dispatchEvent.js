/**
 * Dispatches a custom event with the specified name and detail.
 * @param {string} event - The name of the event to dispatch.
 * @param {*} detail - Additional data to include with the event.
 */
exports.dispatchEvent = function(event, detail) {
  document.dispatchEvent(new CustomEvent(event, {
    bubbles: true,
    cancelable: false,
    detail: detail
  }));
};
