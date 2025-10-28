document.addEventListener('DOMContentLoaded', () => {
    // 1. 定义导航按钮的HTML结构
    const navHTML = `
        <nav class="main-nav">
            <a href="index.html" class="nav-link-home">
                <i class="fa-solid fa-house"></i>
                <span>返回主页</span>
            </a>
        </nav>
    `;

    // 2. 定义导航按钮的CSS样式
    const navCSS = `
        .main-nav {
            position: fixed; /* 固定在屏幕上，不随滚动条滚动 */
            top: 25px;
            left: 25px;
            z-index: 1000; /* 确保它在最顶层 */
        }
        .nav-link-home {
            display: flex;
            align-items: center;
            gap: 8px;
            background-color: rgba(40, 40, 40, 0.7);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            color: #E0E0E0;
            padding: 10px 15px;
            border-radius: 50px; /* 胶囊形状 */
            text-decoration: none;
            border: 1px solid #505050;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }
        .nav-link-home:hover {
            background-color: #007BFF;
            color: #FFFFFF;
            border-color: #007BFF;
            transform: translateY(-2px);
        }
        .nav-link-home span {
            font-weight: 500;
        }
    `;
    
    // 3. 将CSS注入到页面的<head>中
    const styleElement = document.createElement('style');
    styleElement.textContent = navCSS;
    document.head.appendChild(styleElement);
  
    // 4. 将HTML注入到页面的<body>开头
    document.body.insertAdjacentHTML('afterbegin', navHTML);
});
