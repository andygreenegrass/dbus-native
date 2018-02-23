const net = require('net');
const abs = require('abstract-socket');
const hexy = require('hexy').hexy;

const address = process.env.DBUS_SESSION_BUS_ADDRESS;
const m = address.match(/abstract=([^,]+)/);

net
  .createServer(s => {
    let buff = '';
    let connected = false;
    const cli = abs.createConnection(`\0${m[1]}`);
    s.on('data', d => {
      if (connected) {
        cli.write(d);
      } else {
        buff += d.toString();
      }
    });
    setTimeout(() => {
      console.log('CONNECTED!');
      connected = true;
      cli.write(buff);
    }, 100);
    cli.pipe(s);

    cli.on('data', b => {
      console.log(hexy(b, { prefix: 'from client ' }));
    });
    s.on('data', b => {
      console.log(hexy(b, { prefix: 'from server ' }));
    });
  })
  .listen(3334, () => {
    console.log(
      'Server started. connect with DBUS_SESSION_BUS_ADDRESS=tcp:host=127.0.0.1,port=3334'
    );
  });
