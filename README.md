# GCode Sender

GCode Sender is an Electron application designed to interface with Arduino, STM32, and RP2040 projects via GCode over a serial connection.

![image](https://github.com/user-attachments/assets/ad176b5f-24e9-46e5-9d53-fa1faf02ae4e)

## Features

- Connect to serial ports with selectable baud rates.
- Send GCode commands to connected devices.
- Visualize temperatures in graphical form.
- Suggest common GCode commands and and parameters as you type
- View received messages from the device.
- Simple and intuitive user interface.
- Developed using Electron, making it cross-platform.

## Installation

1. Clone the repository:
    ```sh
    git clone https://github.com/Zergie/gcode_sender.git
    cd gcode_sender
    ```

2. Install dependencies:
    ```sh
    npm install
    ```

3. Start the application:
    ```sh
    npm start
    ```

## Usage

1. Launch the application.
2. Select the appropriate serial port and baud rate.
3. Click the "Connect" button to establish a connection.
4. Send GCode commands using the provided interface.
5. View responses from the connected device.

## Development

To contribute to the development of this application:

1. Fork the repository.
2. Create a new branch for your feature or bugfix:
    ```sh
    git checkout -b feature-name
    ```
3. Make your changes and commit them:
    ```sh
    git commit -m "Description of changes"
    ```
4. Push your changes to your fork:
    ```sh
    git push origin feature-name
    ```
5. Create a pull request on GitHub.

## License

This project is licensed under the GPL-2.0-only License. See the [LICENSE](http://_vscodecontentref_/0) file for details.

## Author

Developed by Wolfgang Puchinger.

## Links

- [Homepage](https://github.com/Zergie/gcode_sender)
- [Issues](https://github.com/Zergie/gcode_sender/issues)
