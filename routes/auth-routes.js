require("dotenv").config();
//packages and utilities
const router = require("express").Router();
const pool = require("../db");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const { auth, OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const dayjs = require("dayjs");
const accNo = require("../utilities/acc");
const capNsmalz = require("../utilities/capNsmalz");
const randomString = require("random-string");

// Google Oauth handler
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.CLIENT_REFRESH_TOKEN;
const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

//router
const { Router } = require("express");

//Adds the first 3 numbers needed in creating the account number
const accTypeSavings = "102";
const accTypeCurrent = "202";

//register to create an account
router.post("/verify", async (req, res) => {
  try {
    // details received from client side
    const email = req.body.email;
    const fName = capNsmalz.neat(req.body.fName);
    const mName = capNsmalz.neat(req.body.mName);
    const lName = capNsmalz.neat(req.body.lName);
    const dOB = req.body.dOB;
    const address = capNsmalz.neat(req.body.address);
    const phoneNo = req.body.phoneNo;
    const accountType = req.body.accountType;
    const gender = capNsmalz.neat(req.body.gender);

    // Checks Customer records for existing customers
    const customers = await pool.query(
      "SELECT * FROM customers WHERE customer_email = $1",
      [email]
    );
    if (customers.rows.length !== 0)
      return res.status(403).json({ error: "Customer already exists!" });

    //Deletes customer from Limbo if customer was in limbo to avoid overpopulating the database and errors
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // Hashes 4Digitpin
    const hashedPassword = await bcrypt.hash(req.body.password, 10);

    // Creates confirmation code
    const verify = randomString({ length: 5 });

        //Get access token
        const accessToken = await oAuth2Client.getAccessToken();

        //credentials for email transportation
        const transport = nodemailer.createTransport({
          service: "gmail",
          auth: {
            type: "OAuth2",
            user: "edifyit1@gmail.com",
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            refreshToken: REFRESH_TOKEN,
            accessToken: accessToken,
          },
        });
    
        //Email verification message
        const msg = {
          from: "The Vault <edifyit1@gmail.com>", // sender address
          to: email, // list of receivers
          subject: "Email Verification", // Subject line
          text: `Your confirmation code is ${verify}. If you did not try to register with us, kindly ignore this email.`, // plain text body
          html: `<h1>Email Verification</h1>
                <p>${fName} your confirmation code is <strong>${verify}</strong><br><br>
                If you did not try to register with us, kindly ignore this email.</p>`, //HTML message
        };
    
        // send mail with defined transport object
        const info = await transport.sendMail(msg);

    //saves new customer in limbo
    const customerInLimbo = await pool.query(
      "INSERT INTO limbo(first_name,middle_name,last_name,customer_email,customer_gender,customer_address,customer_phoneno,customer_dob,customer_password,customer_verify,dummy_pin,dummy_accountype) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [
        fName,
        mName,
        lName,
        email,
        gender,
        address,
        phoneNo,
        dOB,
        "empty",
        verify,
        hashedPassword,
        accountType,
      ]
    );



    // sends the status code, message and email to the client as response
    res.status(200).json({
      Registration: "Successful!",
      email: customerInLimbo.rows[0].customer_email,
    });
  } catch (error) {}
});

// create account
router.post("/create", async (req, res) => {
  try {
    //Gets email from client side
    const email = req.body.email;
    const code = req.body.code;

    // dummy account balance for testing
    const accBal = 5000;

    // Checks Limbo records for existing customers in Limbo
    const limboCustomers = await pool.query(
      "SELECT * FROM limbo WHERE customer_email = $1",
      [email]
    );

    // Checks if email has a verification code
    if (limboCustomers.rows.length === 0)
      return res.status(401).json({
        error:
          "Email does not have a verification code, try to register again!",
      });

    // Checks if user typed in the correct verification code that corresponds with the email.
    if (limboCustomers.rows[0].customer_verify !== code)
      return res.status(403).json({ error: "Invalid verification code!" });

    // Gets account type from limbo
    const accountType = limboCustomers.rows[0].dummy_accountype;

    // Generates first 3 digits of the account number based on accType selected from client side
    let typeAcc = await function () {
      let usn = "";
      if (accountType === "Savings") {
        return (usn = accTypeSavings);
      } else if (accountType === "Current") {
        return (usn = accTypeCurrent);
      }
    };

    //saves new customer
    const newCustomer = await pool.query(
      "INSERT INTO customers(first_name,middle_name,last_name,customer_email,customer_gender,customer_address,customer_phoneno,customer_dob,customer_password,c_date,c_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        limboCustomers.rows[0].first_name,
        limboCustomers.rows[0].middle_name,
        limboCustomers.rows[0].last_name,
        limboCustomers.rows[0].customer_email,
        limboCustomers.rows[0].customer_gender,
        limboCustomers.rows[0].customer_address,
        limboCustomers.rows[0].customer_phoneno,
        limboCustomers.rows[0].customer_dob,
        "empty",
        dayjs().format("YYYY-MM-DD"),
        dayjs().format("HH:mm:ss")
      ]
    );

    //gets new customer uuid and other details
    const customerID = newCustomer.rows[0].customer_id;
    const fName = newCustomer.rows[0].first_name;
    const lName = newCustomer.rows[0].last_name;

    // uses new customer uuid to create bank account
    const newAccount = await pool.query(
      "INSERT INTO accounts(account_no,customer_id,account_bal,account_type,account_4digitpin,account_status,account_name,c_date,c_time) VALUEs ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        `${typeAcc()}${accNo.index()}`,
        customerID,
        accBal,
        accountType,
        limboCustomers.rows[0].dummy_pin,
        "Opened",
        `${fName} ${lName}`,
        dayjs().format("YYYY-MM-DD"),
        dayjs().format("HH:mm:ss")
      ]
    );

    //Deletes customer from Limbo
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    const name = newAccount.rows[0].account_name;
    const numb = newAccount.rows[0].account_no;
    const type = newAccount.rows[0].account_type;
    //Get access token
    const accessToken = await oAuth2Client.getAccessToken();

    //credentials for email transportation
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: "edifyit1@gmail.com",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    //Email verification message
    const msg = {
      from: "The Vault <edifyit1@gmail.com>", // sender address
      to: email, // list of receivers
      subject: "Account Details", // Subject line
      text: `${name} here are your account details, Account Name: ${name}, Account Number: ${numb}, Account Type: ${type}. Thanks for choosing THE VAULT...`, // plain text body
      html: `<h1>Account Details</h1>
            <p><strong>${name}</strong> here are your account details<br><br>
            Account Name: ${name}<br>
            Account Number: ${numb}<br>
            Account Type: ${type}<br><br>
            <strong>Thanks for choosing THE VAULT...</strong></p>`, //HTML message
    };

    // send mail with defined transport object
    const info = await transport.sendMail(msg);

    // sends the status code, message and account details to the client as response
    return res.status(200).json({
      Registration: "Successful!",
      account: {
        accName: newAccount.rows[0].account_name,
        accNo: newAccount.rows[0].account_no,
        accType: newAccount.rows[0].account_type,
      },
    });
  } catch (error) {
    res.json({ err: error });
    console.log(error.message);
  }
});

//Sign up for online banking
router.post("/signup", async (req, res) => {
  try {
    const email = req.body.email;
    const accNo = req.body.accNo;
    const four = req.body.four;
    const password = req.body.password;

    // Checks Customer records for existing customers
    const customers = await pool.query(
      "SELECT * FROM customers WHERE customer_email = $1",
      [email]
    );

    // Response if customer is non-existent
    if (customers.rows.length === 0)
      return res.status(401).json({ error: "Customer does not exist!" });

    // Checks Customer records for customers registered for online banking already
    const customersReg = await pool.query(
      "SELECT customer_password FROM customers WHERE customer_email = $1",
      [customers.rows[0].customer_email]
    );
    if (customersReg.rows[0].customer_password !== "empty")
      return res
        .status(404)
        .json({ error: "Customer has an online banking account!" });

    // Checks Account records for existing account's 4digitpin
    const account = await pool.query(
      "SELECT * FROM accounts WHERE customer_id = $1",
      [customers.rows[0].customer_id]
    );

    // response if account is non-existent
    if (account.rows[0].account_no !== accNo)
      return res.status(403).json({ error: "Account does not exist!" });

    //if account exists, compare account 4Digitpin with the one sent from the client side
    const fourCompare = await bcrypt.compare(
      four,
      account.rows[0].account_4digitpin
    );

    if (fourCompare) {
      // Hashes new password
      const hashedPassword = await bcrypt.hash(password, 10);

      //sets user new password
      await pool.query(
        "UPDATE customers SET customer_password = $1 WHERE customer_email  = $2",
        [hashedPassword, customers.rows[0].customer_email]
      );

      return res.status(200).json({ Registration: "Successful!" });
    } else {
      return res.status(406).json({ error: "Invalid 4Digitpin!" });
    }
  } catch (error) {
    res.json({ err: error });
    console.log(error.message);
  }
});

//login begin
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    //Email Check
    const users = await pool.query(
      "SELECT * FROM customers WHERE customer_email = $1",
      [email]
    );
    if (users.rows.length === 0)
      return res.status(401).json({ error: "Email is incorrect!" });

    //Password Check
    if (users.rows[0].customer_password === "empty")
      return res.status(403).json({ error: "Customer is not registered for online banking!" });

    const validPassword = await bcrypt.compare(
      password,
      users.rows[0].customer_password
    );
    if (!validPassword)
      return res.status(401).json({ error: "Incorrect password!" });

    //JWT
    const user_email = users.rows[0].user_email;
    const user_name = `${users.rows[0].first_name} ${users.rows[0].last_name}`;
    const user_id = users.rows[0].customer_id;
    const token = await jwt.sign({ user_id }, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "25m",
    });
    return res.status(200).json({
      auth: true,
      token: token,
      person: { name: user_name, email: user_email, id: user_id },
    });
  } catch (error) {
    return res.status(411).json({ error: error.message });
  }
});

// Passowrd reset section

// sends confirmation code to customer's email
router.post("/codecheck", async (req, res) => {
  try {
    const email = req.body.email;

    //  deletes confirmation code if there was one to prevent conflict
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    const customer = await pool.query(
      "SELECT * FROM customers WHERE customer_email = $1",
      [email]
    );

    if (customer.rows.length === 0)
      return res.status(401).json({ error: "Customer does not exist!" });

    // Creates confirmation code
    const verify = randomString({ length: 5 });

    //saves new customer in limbo
    const customerInLimbo = await pool.query(
      "INSERT INTO limbo(customer_email,customer_verifyy) VALUES ($1,$2) RETURNING *",
      [email, verify]
    );

    //Get access token
    const accessToken = await oAuth2Client.getAccessToken();

    //credentials for email transportation
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: "edifyit1@gmail.com",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken,
      },
    });

    //Email verification message
    const msg = {
      from: "The Vault <edifyit1@gmail.com>", // sender address
      to: email, // list of receivers
      subject: "Password Reset", // Subject line
      text: `Your password reset code is ${verify}. If you did not try to reset your password, kindly ignore this email.Someone typed in your email by mistake.`, // plain text body
      html: `<h1>Password Reset</h1>
            <p>Your password reset code is <strong>${verify}</strong><br><br>
            If you did not try to reset your password, kindly ignore this email. Someone typed in your email by mistake.</p>`, //HTML message
    };

    // send mail with defined transport object
    const info = await transport.sendMail(msg);

    // response
    return res.status(200).json("good");
  } catch (error) {
    return res.status(411).json({ error: error.message });
  }
});

// checks confirmation code
router.post("/codechecka", async (req, res) => {
  try {
    const email = req.body.email;
    const code = req.body.code;

    const customerInLimbo = await pool.query(
      "SELECT * FROM limbo WHERE customer_email = $1",
      [email]
    );

    // checks for valid verification code
    if (customerInLimbo.rows === 0)
      return res.status(401).json({ error: "Verification code non-existent!" });

    if (customerInLimbo.rows[0].customer_verifyy !== code)
      return res
        .status(401)
        .json({ error: "expired or invalid verification code!" });

    await pool.query(
      "UPDATE customers SET customer_password = $1 WHERE customer_email = $2",
      ["empty", email]
    );

    // response
    return res.status(200).json("good");
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});

// password rester API
router.put("/resetpass", async (req, res) => {
  try {
    const { email, password } = req.body;

    // hashes password
    const hashedPassword = await bcrypt.hash(password, 10);

    const pWordCheck = await pool.query(
      "SELECT * FROM customers WHERE customer_email = $1",
      [email]
    );
    const pWordCheckA = await pool.query(
      "SELECT * FROM accounts WHERE customer_id = $1",
      [pWordCheck.rows[0].customer_id]
    );

    // checks if its the customer making the request
    if (
      pWordCheck.rows[0].customer_password !== "empty" &&
      pWordCheckA.rows.length !== 0
    )
      return res
        .status(403)
        .json({
          error:
            "Malicious request! you cannot out smart me you hacker hehehe...",
        });
    if (
      pWordCheck.rows[0].customer_password === "empty" &&
      pWordCheckA.rows.length === 0
    )
      return res
        .status(403)
        .json({
          error:
            "Malicious request! you cannot out smart me you hacker hehehe...",
        });

    // updates password
    const pWordUpdate = await pool.query(
      "UPDATE customers SET customer_password = $1 WHERE customer_email = $2",
      [hashedPassword, email]
    );

    // deletes verification code
    const deleteVerificationCode = await pool.query(
      "DELETE FROM limbo WHERE customer_email = $1",
      [email]
    );

    // response
    return res.status(200).json("Password updated!");
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
});
/* Password reset ends */

/* Admin Route */
// get customers
router.get("/customers", async(req, res) => {
  try {
    const customers = await pool.query("SELECT * FROM customers;");
    
    return res.status(200).json(customers.rows);
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
})
// get customers accounts
router.get("/customersacc/:id", async(req, res) => {
  try {
    const id = req.params.id;
    const userAccounts = await pool.query(
      "SELECT * FROM accounts WHERE customer_id = $1 ORDER BY c_date DESC, c_time DESC",
      [id]
    );
    
    return res.status(200).json({accounts: userAccounts.rows});
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
})

// blocks or unblocks customers
router.put("/status", async(req, res) => {
  try {
    const accNo = req.body.accNo;
    const account = await pool.query(
      "SELECT * FROM accounts WHERE account_no = $1",
      [accNo]
    );

    let accStat = await function () {
      let status = "";
      if (account.rows[0].account_status === "Closed") {
        return (status = "Opened");
      } else if (account.rows[0].account_status === "Opened") {
        return (status = "Closed");
      }
    };
    
    const accountSet = await pool.query("UPDATE accounts SET account_status = $1 WHERE account_no = $2", [`${accStat()}`, accNo]);
     
    return res.status(200).json("Ok!");
  } catch (error) {
    
  }
});

// get transaction history of account
router.get("/custran/:no", async (req, res) => {
  try {
    const accountNo = req.params.no;

    const userTransactions = await pool.query(
      "SELECT * FROM transactions WHERE s_account_no = $1 AND transaction_type = $4  OR r_account_no = $2 AND transaction_status = $3 AND transaction_type = $5 ORDER BY transaction_date DESC, transaction_time DESC",
      [accountNo, accountNo, "Successful", "Debit", "Credit"]
    );

    res.json({ transactions: userTransactions.rows });
  } catch (error) {
    console.log(error.message);
  }
});

// reverses transactions
router.delete("/reverse", async (req, res) => {
  try {
    const id = req.body.id;

    // gets details of the transaction
    const transdetailsSender = await pool.query("SELECT * FROM transactions WHERE transaction_id = $1", [id]);
    const transdetailsReceiver = await pool.query("SELECT * FROM transactions WHERE transaction_id = $1", [
      transdetailsSender.rows[0].child_transaction_id
    ]);

    // gets amount to tamper with
    const charge = Number(transdetailsSender.rows[0].transaction_amount) - Number(transdetailsReceiver.rows[0].transaction_amount);
    const sender = transdetailsSender.rows[0].s_account_no;
    const receiver = transdetailsSender.rows[0].r_account_no;

    // gets the details of the customers involved in the transaction
    const senderAcc = await pool.query("SELECT * FROM accounts WHERE account_no = $1", [sender]);
    const receiverAcc = await pool.query("SELECT * FROM accounts WHERE account_no = $1", [receiver]);
    const bank = await pool.query("SELECT * FROM accounts WHERE account_no = $1", ["1027557580"]);

    // tampers with customers balance
    const senderBal = Number(senderAcc.rows[0].account_bal) + Number(transdetailsSender.rows[0].transaction_amount);
    const receiverBal = Number(receiverAcc.rows[0].account_bal) - Number(transdetailsReceiver.rows[0].transaction_amount);
    const bankBal = Number(bank.rows[0].account_bal) - Number(charge);

    // updates the account balance of all parties involved
    const updateSenderBal = await pool.query("UPDATE accounts SET account_bal = $1 WHERE account_no = $2", [
      Number(senderBal),
      sender
    ]);
    const updateReceiverBal = await pool.query("UPDATE accounts SET account_bal = $1 WHERE account_no = $2", [
      Number(receiverBal),
      receiver
    ]);
    const updateBankBal = await pool.query("UPDATE accounts SET account_bal = $1 WHERE account_no = $2", [
      Number(bankBal),
      "1027557580"
    ]);

    // delete the transactions
    const reverseTransactions = await pool.query(
      "DELETE FROM transactions WHERE parent_transaction_id = $1",
      [id]
    );

    // reponse
    res.status(200).json("reversed!");
  } catch (error) {
    console.log(error.message);
  }
});
/* Admin Route ends */

//Exports auth-routes.js
module.exports = router;
