const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const paperRoutes = require("./routes/paperRoutes");
const auditRoutes = require("./routes/auditRoutes");

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Connect MongoDB
connectDB();

// Authentication routes
app.use("/api/auth", authRoutes);

// Paper routes
app.use("/api/papers", paperRoutes);

// Audit routes
app.use("/api/audit", auditRoutes);

// Test route
app.get("/", (req, res) => {
    res.json({
        message: "Secure Exam Question Paper System API is running"
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});