exports.neat = function(yourName) {
    let firstChar = yourName.slice(0,1);
firstChar = firstChar.toUpperCase();
let restChar = yourName.slice(1,yourName.length);
restChar = restChar.toLowerCase();
const newName = firstChar + restChar;

  
  
    return newName;
  };

exports.smooth = function(yourEmail) {
    let jEmail = yourEmail.length - 6;

    let justEmail = yourEmail.slice(0,jEmail);

  
    return justEmail;
  };

exports.smoothEnd = function(yourEmail) {
    let jEmail = yourEmail.length - 6;

    let justEmail = yourEmail.slice(jEmail,yourEmail.length);

  
    return justEmail;
  };