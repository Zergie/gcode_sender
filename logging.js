const old_console_error = console.error;
var console_log = console.log;

function show_error(msg) {
  try {
    document.getElementById("hasNoError").checked = false;
    const div = document.querySelector("#global-error span");
    div.innerText = msg;
  } catch (e) {
    old_console_error("Error displaying error message:", e);
  }
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

exports.console_error = (msg) => show_error(msg);

exports.console_log = function () {
  var args = Array.from(arguments);

  if (args.length > 1) {
    try {
      args = [
        args[0],
        JSON.stringify(args.slice(1)),
      ]
    } 
    catch {
    }
  }

  console_log.apply(console, args);
}