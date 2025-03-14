function show_error(msg) {
  document.getElementById("hasNoError").checked = false;
  const div = document.querySelector("#global-error span");
  div.innerText = msg;
}

exports.onerror = function (msg, url, line, col, error) {
  // Note that col & error are new to the HTML 5 spec and may not be 
  // supported in every browser.  It worked for me in Chrome.
  var extra = !col ? '' : '\ncolumn: ' + col;
  extra += !error ? '' : '\nerror: ' + error;

  // You can view the information in an alert to see things working like this:
  // alert("Error: " + msg + "\nurl: " + url + "\nline: " + line + extra);

  show_error("Error: " + msg + "\nurl: " + url + "\nline: " + line + extra);

  return false;
};

exports.console_onerror = (msg) => show_error(msg);