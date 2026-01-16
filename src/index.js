import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

// Store the current parsed data structure
let currentData = null;

// Debounce timer for validation
let validationTimer = null;

// Validation debounce delay (ms)
const VALIDATION_DEBOUNCE_DELAY = 300;

// Dynamic API base URL: MCP injects window.API_BASE_URL, fallback to localhost for local dev
// This allows the same code to work in both MCP deployment and local development
const API_BASE_URL = (typeof window !== 'undefined' && window.API_BASE_URL) || 'http://localhost:3000';


// Debug: Log which API base URL is being used (remove in production if desired)
if (typeof window !== 'undefined') {
    console.log('[Brief2Check] API Base URL:', API_BASE_URL);
    console.log('[Brief2Check] window.API_BASE_URL:', window.API_BASE_URL || '(not set, using localhost fallback)');
}

/**
 * Extracts JSON from API response, handling markdown code blocks if present
 * @param {string} responseText - The raw response text from API
 * @returns {string} - Extracted JSON string
 */
function extractJsonFromResponse(text) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('No JSON object found in Gemini response');
    }
    return text.substring(firstBrace, lastBrace + 1);
}


/**
 * Validates the JSON structure matches expected format (accepts strings for backward compatibility)
 * @param {object} data - Parsed JSON object
 * @returns {object} - Validation result with isValid flag and error message
 */
function validateJsonStructure(data) {
    // Check if data exists and is an object
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {
            isValid: false,
            error: 'Invalid response: expected an object with department keys'
        };
    }
    
    // Check that all values are arrays
    for (const key in data) {
        if (!Array.isArray(data[key])) {
            return {
                isValid: false,
                error: `Invalid structure: department "${key}" should be an array, got ${typeof data[key]}`
            };
        }
        
        // Check that all array items are strings (API returns strings, we convert to objects later)
        if (!data[key].every(task => typeof task === 'string')) {
            return {
                isValid: false,
                error: `Invalid structure: department "${key}" contains non-string items`
            };
        }
    }
    
    // Check for empty object (no departments)
    if (Object.keys(data).length === 0) {
        return {
            isValid: false,
            error: 'Invalid response: no departments found in the response'
        };
    }
    
    return { isValid: true, error: null };
}

/**
 * Converts task data from API format (strings) to internal format (objects with text and completed)
 * @param {object} data - Data with string tasks
 * @returns {object} - Data with object tasks {text: string, completed: boolean}
 */
function convertTasksToObjects(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }
    
    const converted = {};
    for (const department in data) {
        if (Array.isArray(data[department])) {
            converted[department] = data[department].map(task => {
                // If already an object with text/completed, preserve it
                if (typeof task === 'object' && task !== null && 'text' in task) {
                    return {
                        text: task.text || '',
                        completed: task.completed === true
                    };
                }
                // If string, convert to object
                if (typeof task === 'string') {
                    return {
                        text: task,
                        completed: false
                    };
                }
                // Fallback
                return {
                    text: String(task),
                    completed: false
                };
            });
        } else {
            converted[department] = [];
        }
    }
    
    return converted;
}

/**
 * Parses and validates JSON from API response
 * @param {string|object} responseData - Response data (string or already parsed object)
 * @returns {object} - Parsed and validated department-grouped tasks
 * @throws {Error} - If parsing or validation fails
 */
function parseAndValidateJson(responseData) {
    let parsedData;
    
    // If responseData is already an object, use it directly
    if (typeof responseData === 'object' && responseData !== null) {
        parsedData = responseData;
    } else if (typeof responseData === 'string') {
        // Extract JSON from string (handling markdown code blocks)
        const jsonString = extractJsonFromResponse(responseData);
        
        // Parse JSON
        try {
            parsedData = JSON.parse(jsonString);
        } catch (parseError) {
            throw new Error(`Failed to parse JSON response: ${parseError.message}. The response may not be valid JSON.`);
        }
    } else {
        throw new Error(`Invalid response type: expected string or object, got ${typeof responseData}`);
    }
    
    // Validate structure
    const validation = validateJsonStructure(parsedData);
    if (!validation.isValid) {
        throw new Error(validation.error);
    }
    
    return parsedData;
}

/**
 * Calls the local API endpoint to parse design instructions
 * @param {string} instructions - User's design instructions
 * @returns {Promise<object>} - Parsed department-grouped tasks
 */
async function parseInstructions(instructions) {
    const response = await fetch(`${API_BASE_URL}/api/parse-instructions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instructions })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || `Request failed with status ${response.status}`;
        
        if (response.status === 401) {
            throw new Error('Invalid API key. Please check server configuration.');
        } else if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please try again later.');
        } else if (response.status >= 500) {
            throw new Error('Server error. Please try again later.');
        } else {
            throw new Error(errorMessage);
        }
    }

    // Get response data (could be JSON or text)
    // Read as text first to handle both JSON and text responses, including edge cases
    const responseText = await response.text();
    
    // Try to parse as JSON if content-type suggests JSON, otherwise try to extract JSON from text
    let responseData;
    const contentType = response.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
        // Content-type says JSON, try parsing directly
        try {
            responseData = JSON.parse(responseText);
        } catch (parseError) {
            // If direct parsing fails, try extracting JSON from text (might be wrapped in markdown)
            responseData = responseText;
        }
    } else {
        // Not JSON content-type, treat as text and extract JSON
        responseData = responseText;
    }
    
    // Parse and validate the response
    const parsedData = parseAndValidateJson(responseData);
    
    // Convert string tasks to object tasks (with text and completed properties)
    return convertTasksToObjects(parsedData);
}

/**
 * Validates a single task text value
 * @param {string} text - Task text to validate
 * @returns {object} - Validation result with isValid flag and error message
 */
function validateTaskText(text) {
    if (typeof text !== 'string') {
        return {
            isValid: false,
            error: 'Task text must be a string'
        };
    }
    
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return {
            isValid: false,
            error: 'Task cannot be empty'
        };
    }
    
    if (trimmed.length > 1000) {
        return {
            isValid: false,
            error: 'Task is too long (max 1000 characters)'
        };
    }
    
    return { isValid: true, error: null };
}

/**
 * Updates the task text in the data structure (preserves completion state)
 * @param {string} department - Department name
 * @param {number} index - Task index
 * @param {string} text - New task text
 */
function updateTaskTextInData(department, index, text) {
    if (!currentData || !currentData[department]) {
        return;
    }
    
    // Ensure the array exists and has enough elements
    if (!Array.isArray(currentData[department])) {
        currentData[department] = [];
    }
    
    // Ensure task is an object
    if (!currentData[department][index] || typeof currentData[department][index] !== 'object') {
        currentData[department][index] = { text: '', completed: false };
    }
    
    // Update the task text, preserving completion state
    currentData[department][index].text = text;
    
    // Validate the entire structure
    validateDataStructure();
}

/**
 * Updates the task completion state
 * @param {string} department - Department name
 * @param {number} index - Task index
 * @param {boolean} completed - New completion state
 */
function updateTaskCompletionInData(department, index, completed) {
    if (!currentData || !currentData[department]) {
        return;
    }
    
    // Ensure the array exists and has enough elements
    if (!Array.isArray(currentData[department])) {
        currentData[department] = [];
    }
    
    // Ensure task is an object
    if (!currentData[department][index] || typeof currentData[department][index] !== 'object') {
        currentData[department][index] = { text: currentData[department][index] || '', completed: false };
    }
    
    // Update the completion state
    currentData[department][index].completed = completed === true;
    
    // Update progress indicator
    updateProgressIndicator();
}

/**
 * Validates the entire currentData structure
 */
function validateDataStructure() {
    if (!currentData) return;
    
    // Ensure all departments have arrays with proper task objects
    for (const department in currentData) {
        if (!Array.isArray(currentData[department])) {
            currentData[department] = [];
        } else {
            // Ensure all tasks are objects
            currentData[department] = currentData[department].map(task => {
                if (typeof task === 'object' && task !== null && 'text' in task) {
                    return {
                        text: task.text || '',
                        completed: task.completed === true
                    };
                }
                // Convert string to object
                return {
                    text: typeof task === 'string' ? task : String(task),
                    completed: false
                };
            });
        }
    }
}

/**
 * Calculates progress statistics
 * @returns {object} - Object with completed and total counts
 */
function calculateProgress() {
    if (!currentData) {
        return { completed: 0, total: 0 };
    }
    
    let completed = 0;
    let total = 0;
    
    for (const department in currentData) {
        if (Array.isArray(currentData[department])) {
            currentData[department].forEach(task => {
                total++;
                if (task && typeof task === 'object' && task.completed === true) {
                    completed++;
                }
            });
        }
    }
    
    return { completed, total };
}

/**
 * Updates the progress indicator in the UI
 */
function updateProgressIndicator() {
    const progressIndicator = document.getElementById('progressIndicator');
    if (!progressIndicator) return;
    
    const { completed, total } = calculateProgress();
    progressIndicator.textContent = `${completed} / ${total} tasks completed`;
}

/**
 * Removes a task from the data structure
 * @param {string} department - Department name
 * @param {number} index - Task index to remove
 */
function removeTask(department, index) {
    if (!currentData || !currentData[department] || !Array.isArray(currentData[department])) {
        return;
    }
    
    currentData[department].splice(index, 1);
    
    // Update progress
    updateProgressIndicator();
    
    // Re-render to update indices
    renderDepartmentGroups(currentData);
    
    // Update export section
    updateExportSection();
}

/**
 * Adds a new task to a department
 * @param {string} department - Department name
 */
function addTask(department) {
    if (!currentData) {
        currentData = {};
    }
    
    if (!currentData[department]) {
        currentData[department] = [];
    }
    
    if (!Array.isArray(currentData[department])) {
        currentData[department] = [];
    }
    
    // Add new task object (unchecked by default)
    currentData[department].push({
        text: '',
        completed: false
    });
    
    // Update progress
    updateProgressIndicator();
    
    // Re-render to show new task
    renderDepartmentGroups(currentData);
    
    // Update export section
    updateExportSection();
    
    // Focus on the new task input
    setTimeout(() => {
        const departmentGroups = document.getElementById("departmentGroups");
        const departmentGroup = Array.from(departmentGroups.querySelectorAll('.department-group')).find(
            group => group.querySelector('.department-header').textContent === department
        );
        
        if (departmentGroup) {
            const taskItems = departmentGroup.querySelectorAll('.task-item');
            const lastTaskItem = taskItems[taskItems.length - 1];
            if (lastTaskItem) {
                const input = lastTaskItem.querySelector('input, textarea');
                if (input) {
                    input.focus();
                    input.classList.add('editing');
                }
            }
        }
    }, 50);
}

/**
 * Creates a task checklist element with checkbox and editable text
 * @param {string} department - Department name
 * @param {number} index - Task index
 * @param {object} task - Task object with {text, completed}
 * @returns {HTMLElement} - Task item element
 */
function createTaskElement(department, index, task) {
    // Ensure task is an object
    const taskObj = typeof task === 'object' && task !== null && 'text' in task
        ? task
        : { text: typeof task === 'string' ? task : String(task), completed: false };
    
    const taskItem = document.createElement("div");
    taskItem.className = "task-item";
    taskItem.setAttribute("data-department", department);
    taskItem.setAttribute("data-index", index);
    
    // Checkbox wrapper
    const checkboxWrapper = document.createElement("div");
    checkboxWrapper.className = "task-checkbox-wrapper";
    
    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-checkbox";
    checkbox.checked = taskObj.completed === true;
    checkbox.setAttribute("aria-label", `Mark task ${index + 1} as ${taskObj.completed ? 'incomplete' : 'complete'}`);
    
    // Checkbox change handler
    checkbox.addEventListener("change", () => {
        updateTaskCompletionInData(department, index, checkbox.checked);
        // Update visual state
        if (checkbox.checked) {
            taskItem.classList.add("task-completed");
        } else {
            taskItem.classList.remove("task-completed");
        }
    });
    
    // Set initial completed state
    if (taskObj.completed) {
        taskItem.classList.add("task-completed");
    }
    
    checkboxWrapper.appendChild(checkbox);
    
    // Text input wrapper
    const textWrapper = document.createElement("div");
    textWrapper.className = "task-text-wrapper";
    
    // Use textarea for better text wrapping (always use textarea for proper wrapping)
    const inputElement = document.createElement("textarea");
    inputElement.value = taskObj.text;
    inputElement.placeholder = `Task ${index + 1}`;
    inputElement.className = "task-text-input";
    inputElement.setAttribute("data-department", department);
    inputElement.setAttribute("data-index", index);
    inputElement.rows = 1; // Start with single row, will auto-resize
    
    // Auto-resize textarea
    const autoResize = () => {
        inputElement.style.height = 'auto';
        inputElement.style.height = Math.max(24, inputElement.scrollHeight) + 'px';
    };
    
    // Validation message
    const validationMessage = document.createElement("div");
    validationMessage.className = "validation-message";
    
    // Task actions (delete icon)
    const taskActions = document.createElement("div");
    taskActions.className = "task-actions";
    
    const deleteIcon = document.createElement("button");
    deleteIcon.className = "task-delete-icon";
    deleteIcon.textContent = "×";
    deleteIcon.setAttribute("aria-label", "Delete task");
    deleteIcon.setAttribute("type", "button");
    deleteIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTask(department, index);
    });
    
    taskActions.appendChild(deleteIcon);
    
    // Real-time validation on input
    let validationTimeout = null;
    inputElement.addEventListener("input", () => {
        const value = inputElement.value;
        
        // Auto-resize
        autoResize();
        
        // Mark as editing
        inputElement.classList.add("editing");
        
        // Clear previous validation timeout
        if (validationTimeout) {
            clearTimeout(validationTimeout);
        }
        
        // Debounced validation
        validationTimeout = setTimeout(() => {
            const validation = validateTaskText(value);
            
            if (validation.isValid) {
                inputElement.classList.remove("invalid");
                inputElement.classList.remove("editing");
                validationMessage.classList.remove("show");
                validationMessage.textContent = "";
                
                // Update data structure (preserves completion state)
                updateTaskTextInData(department, index, value);
            } else {
                inputElement.classList.add("invalid");
                inputElement.classList.remove("editing");
                validationMessage.textContent = validation.error;
                validationMessage.classList.add("show");
            }
        }, VALIDATION_DEBOUNCE_DELAY);
        
        // Update data immediately (even if invalid, for real-time editing)
        updateTaskTextInData(department, index, value);
    });
    
    // Validate on blur
    inputElement.addEventListener("blur", () => {
        inputElement.classList.remove("editing");
        autoResize();
        
        // Clear any pending validation timeout and validate immediately
        if (validationTimeout) {
            clearTimeout(validationTimeout);
        }
        
        const validation = validateTaskText(inputElement.value);
        if (!validation.isValid) {
            inputElement.classList.add("invalid");
            validationMessage.textContent = validation.error;
            validationMessage.classList.add("show");
        } else {
            inputElement.classList.remove("invalid");
            validationMessage.classList.remove("show");
            validationMessage.textContent = "";
        }
    });
    
    // Focus event
    inputElement.addEventListener("focus", () => {
        inputElement.classList.add("editing");
        autoResize();
    });
    
    // Initial validation
    const initialValidation = validateTaskText(taskObj.text);
    if (!initialValidation.isValid && taskObj.text.trim().length > 0) {
        inputElement.classList.add("invalid");
        validationMessage.textContent = initialValidation.error;
        validationMessage.classList.add("show");
    }
    
    // Initial auto-resize
    setTimeout(autoResize, 0);
    
    textWrapper.appendChild(inputElement);
    textWrapper.appendChild(taskActions);
    
    taskItem.appendChild(checkboxWrapper);
    taskItem.appendChild(textWrapper);
    taskItem.appendChild(validationMessage);
    
    return taskItem;
}

// Function to render department groups with editable tasks
function renderDepartmentGroups(data) {
    const departmentGroups = document.getElementById("departmentGroups");
    departmentGroups.innerHTML = "";

    if (!data || Object.keys(data).length === 0) {
        departmentGroups.innerHTML = '<div class="empty-state">No tasks found. Try parsing your instructions again.</div>';
        return;
    }

    // Ensure data structure is valid
    validateDataStructure();

    // Department order (can be customized)
    const departmentOrder = ["Marketing", "Product", "Legal", "Brand", "Other"];
    const departments = Object.keys(data).sort((a, b) => {
        const aIndex = departmentOrder.indexOf(a);
        const bIndex = departmentOrder.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    departments.forEach(department => {
        const tasks = data[department];
        
        // Show department even if empty (allow adding tasks)
        const departmentGroup = document.createElement("div");
        departmentGroup.className = "department-group";

        const header = document.createElement("h3");
        header.className = "department-header";
        header.textContent = department;
        departmentGroup.appendChild(header);

        const tasksList = document.createElement("div");
        tasksList.className = "tasks-list";

        // Render existing tasks
        if (tasks && Array.isArray(tasks) && tasks.length > 0) {
            tasks.forEach((task, index) => {
                const taskElement = createTaskElement(department, index, task);
                tasksList.appendChild(taskElement);
            });
        }

        // Add task control (compact inline)
        const addTaskControl = document.createElement("div");
        addTaskControl.className = "add-task-control";
        
        const addTaskIcon = document.createElement("span");
        addTaskIcon.className = "add-task-icon";
        addTaskIcon.textContent = "＋";
        
        const addTaskLabel = document.createElement("span");
        addTaskLabel.className = "add-task-label";
        addTaskLabel.textContent = "Add task";
        
        addTaskControl.appendChild(addTaskIcon);
        addTaskControl.appendChild(addTaskLabel);
        
        addTaskControl.addEventListener("click", () => {
            addTask(department);
        });
        
        tasksList.appendChild(addTaskControl);
        departmentGroup.appendChild(tasksList);
        departmentGroups.appendChild(departmentGroup);
    });
    
    // Update progress indicator after rendering
    updateProgressIndicator();
    
    // Update export section visibility and department options
    updateExportSection();
}

/**
 * Updates the export section visibility and populates department dropdown
 */
function updateExportSection() {
    const exportSection = document.getElementById('exportSection');
    const departmentSelect = document.getElementById('departmentSelect');
    
    if (!exportSection || !departmentSelect) return;
    
    // Show export section if there's data
    if (currentData && Object.keys(currentData).length > 0) {
        exportSection.style.display = 'flex';
        
        // Clear existing options except the first one
        departmentSelect.innerHTML = '<option value="">Select department...</option>';
        
        // Add departments that have tasks
        const departmentOrder = ["Marketing", "Product", "Legal", "Brand", "Other"];
        const departments = Object.keys(currentData).sort((a, b) => {
            const aIndex = departmentOrder.indexOf(a);
            const bIndex = departmentOrder.indexOf(b);
            if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            return aIndex - bIndex;
        });
        
        departments.forEach(dept => {
            if (currentData[dept] && Array.isArray(currentData[dept]) && currentData[dept].length > 0) {
                const option = document.createElement('option');
                option.value = dept;
                option.textContent = dept;
                departmentSelect.appendChild(option);
            }
        });
        
        // Reset selection
        departmentSelect.value = '';
        updateExportButtonState();
    } else {
        exportSection.style.display = 'none';
    }
}

/**
 * Updates the export button enabled/disabled state
 */
function updateExportButtonState() {
    const exportButton = document.getElementById('exportButton');
    const departmentSelect = document.getElementById('departmentSelect');
    
    if (exportButton && departmentSelect) {
        exportButton.disabled = !departmentSelect.value;
    }
}

/**
 * Generates export text for a specific department
 * @param {string} department - Department name
 * @returns {string} - Formatted export text
 */
function generateExportText(department) {
    if (!currentData || !currentData[department] || !Array.isArray(currentData[department])) {
        return '';
    }
    
    const tasks = currentData[department];
    if (tasks.length === 0) {
        return '';
    }
    
    // Get current timestamp
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
    });
    
    // Build export text
    let exportText = `${department}\n`;
    exportText += `Status as of ${timeString}\n\n`;
    
    tasks.forEach((task, index) => {
        const taskObj = typeof task === 'object' && task !== null && 'text' in task
            ? task
            : { text: typeof task === 'string' ? task : String(task), completed: false };
        
        const status = taskObj.completed === true ? '✔️ Completed' : '⏳ In progress';
        exportText += `${index + 1}. ${taskObj.text}\n`;
        exportText += `   Status: ${status}\n\n`;
    });
    
    return exportText.trim();
}

/**
 * Fallback copy to clipboard method for restricted environments
 * @param {string} text - Text to copy
 * @returns {boolean} - True if successful
 */
function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (err) {
        document.body.removeChild(textArea);
        return false;
    }
}

/**
 * Shows export preview modal with checklist status
 */
function exportChecklistStatus() {
    const departmentSelect = document.getElementById('departmentSelect');
    if (!departmentSelect || !departmentSelect.value) {
        return;
    }
    
    const department = departmentSelect.value;
    const exportText = generateExportText(department);
    
    if (!exportText) {
        showError('No tasks found for this department.');
        return;
    }
    
    // Show preview modal
    showExportPreviewModal(department, exportText);
}

/**
 * Copies text to clipboard with fallback methods
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} - True if successful
 */
async function copyToClipboardWithFallback(text) {
    // Try modern Clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            console.log('Clipboard API failed, trying fallback:', error);
        }
    }
    
    // Use fallback method if Clipboard API failed or unavailable
    return fallbackCopyToClipboard(text);
}

/**
 * Shows export preview modal with checklist status
 * @param {string} department - Department name
 * @param {string} exportText - Generated export text
 */
function showExportPreviewModal(department, exportText) {
    // Remove any existing modal
    const existingModal = document.getElementById('exportPreviewModal');
    if (existingModal) {
        document.body.removeChild(existingModal);
    }
    
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'exportPreviewModal';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
    `;
    
    // Create modal content with fixed header, scrollable content, and fixed footer
    const modal = document.createElement('div');
    modal.style.cssText = `
        background: white;
        border-radius: 8px;
        max-width: 600px;
        max-height: 80vh;
        width: 100%;
        display: flex;
        flex-direction: column;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        overflow: hidden;
    `;
    
    // Header (fixed)
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #e0e0e0;
        flex-shrink: 0;
        background: white;
    `;
    
    const title = document.createElement('h3');
    title.textContent = department;
    title.style.cssText = 'margin: 0; font-size: 16px; font-weight: 600; color: rgb(82, 88, 228);';
    
    const closeButton = document.createElement('button');
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.style.cssText = `
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #666;
        padding: 0;
        width: 30px;
        height: 30px;
        line-height: 1;
        transition: color 0.2s;
    `;
    closeButton.addEventListener('mouseenter', () => {
        closeButton.style.color = '#333';
    });
    closeButton.addEventListener('mouseleave', () => {
        closeButton.style.color = '#666';
    });
    
    // Scrollable content area
    const contentWrapper = document.createElement('div');
    contentWrapper.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        min-height: 0;
    `;
    
    // Preview content (read-only textarea)
    const preview = document.createElement('textarea');
    preview.value = exportText;
    preview.readOnly = true;
    preview.style.cssText = `
        width: 100%;
        min-height: 200px;
        padding: 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.6;
        box-sizing: border-box;
        background-color: #f8f9fa;
        color: #333;
        resize: none;
    `;
    
    // Footer (fixed, always visible)
    const footer = document.createElement('div');
    footer.style.cssText = `
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        padding: 16px 20px;
        border-top: 1px solid #e0e0e0;
        flex-shrink: 0;
        background: white;
    `;
    
    const exportPdfButton = document.createElement('button');
    exportPdfButton.textContent = 'Export to PDF';
    exportPdfButton.style.cssText = `
        background-color: rgb(82, 88, 228);
        border-color: rgb(82, 88, 228);
        color: rgb(255, 255, 255);
        font-size: 13px;
        padding: 8px 16px;
        height: auto;
        min-height: 36px;
        border-radius: 8px;
        border-style: solid;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s;
    `;
    exportPdfButton.addEventListener('mouseenter', () => {
        exportPdfButton.style.backgroundColor = 'rgb(64, 70, 202)';
    });
    exportPdfButton.addEventListener('mouseleave', () => {
        exportPdfButton.style.backgroundColor = 'rgb(82, 88, 228)';
    });
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.className = 'secondary-button';
    closeBtn.style.cssText = `
        font-size: 13px;
        padding: 8px 16px;
        height: auto;
        min-height: 36px;
    `;
    
    // Export to PDF button handler
    exportPdfButton.addEventListener('click', () => {
        exportToPDF(department, exportText);
    });
    
    // Close handlers
    const closeModal = () => {
        document.body.removeChild(overlay);
    };
    
    closeButton.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeModal();
        }
    });
    
    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closeModal();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
    
    // Assemble modal
    header.appendChild(title);
    header.appendChild(closeButton);
    contentWrapper.appendChild(preview);
    footer.appendChild(exportPdfButton);
    footer.appendChild(closeBtn);
    
    modal.appendChild(header);
    modal.appendChild(contentWrapper);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    // Focus preview for easy selection
    setTimeout(() => {
        preview.focus();
    }, 100);
}

/**
 * Gets the jsPDF constructor, waiting for it to load if necessary
 * @returns {Promise<Function>} - The jsPDF constructor
 */
function getJsPDF() {
    return new Promise((resolve, reject) => {
        // Check if already available
        let jsPDF;
        if (window.jspdf && window.jspdf.jsPDF) {
            jsPDF = window.jspdf.jsPDF;
        } else if (window.jsPDF) {
            jsPDF = window.jsPDF;
        } else if (window.jspdf && typeof window.jspdf === 'function') {
            jsPDF = window.jspdf;
        }
        
        if (jsPDF) {
            resolve(jsPDF);
            return;
        }
        
        // Wait for script to load (max 5 seconds)
        let attempts = 0;
        const maxAttempts = 50; // 50 attempts * 100ms = 5 seconds
        const checkInterval = setInterval(() => {
            attempts++;
            if (window.jspdf && window.jspdf.jsPDF) {
                clearInterval(checkInterval);
                resolve(window.jspdf.jsPDF);
            } else if (window.jsPDF) {
                clearInterval(checkInterval);
                resolve(window.jsPDF);
            } else if (window.jspdf && typeof window.jspdf === 'function') {
                clearInterval(checkInterval);
                resolve(window.jspdf);
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                reject(new Error('jsPDF library failed to load after 5 seconds'));
            }
        }, 100);
    });
}

/**
 * Exports checklist status to PDF
 * @param {string} department - Department name
 * @param {string} exportText - Generated export text (for reference, but we use currentData directly)
 */
async function exportToPDF(department, exportText) {
    if (!currentData || !currentData[department] || !Array.isArray(currentData[department])) {
        showError('No tasks found for this department.');
        return;
    }
    
    try {
        // Get jsPDF constructor (wait for it to load if necessary)
        const jsPDF = await getJsPDF();
        console.log('jsPDF loaded successfully, creating PDF...');
        
        // Create new PDF document
        const doc = new jsPDF();
    
        // Set font and margins
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 20;
        const maxWidth = pageWidth - (margin * 2);
        let yPosition = margin;
        
        // Department name (header)
        doc.setFontSize(16);
        doc.setFont(undefined, 'bold');
        doc.text(department, margin, yPosition);
        yPosition += 10;
        
        // Timestamp
        const now = new Date();
        const timeString = now.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
        });
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(100, 100, 100);
        doc.text(`Status as of ${timeString}`, margin, yPosition);
        yPosition += 15;
        
        // Reset text color and font
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(11);
        doc.setFont(undefined, 'normal');
        
        // Get tasks directly from currentData
        const tasks = currentData[department];
        
        if (!tasks || tasks.length === 0) {
            doc.setFontSize(11);
            doc.text('No tasks available for this department.', margin, yPosition);
        } else {
            // Add tasks to PDF
            for (const task of tasks) {
                const taskObj = typeof task === 'object' && task !== null && 'text' in task
                    ? task
                    : { text: typeof task === 'string' ? task : String(task), completed: false };
                
                // Check if we need a new page
                if (yPosition > pageHeight - 40) {
                    doc.addPage();
                    yPosition = margin;
                }
                
                // Task text with icon
                const statusIcon = taskObj.completed === true ? '✓' : '○';
                const taskLine = `${statusIcon} ${taskObj.text || '(empty task)'}`;
                const taskLines = doc.splitTextToSize(taskLine, maxWidth);
                
                doc.text(taskLines, margin, yPosition);
                yPosition += taskLines.length * 6;
                
                // Status line (indented, smaller, gray)
                doc.setFontSize(9);
                doc.setTextColor(100, 100, 100);
                const status = taskObj.completed === true ? 'Completed' : 'In progress';
                const statusText = `  Status: ${status}`;
                doc.text(statusText, margin, yPosition);
                yPosition += 8;
                
                // Reset for next task
                doc.setFontSize(11);
                doc.setTextColor(0, 0, 0);
                yPosition += 3; // Spacing between tasks
            }
        }
        
        // Generate filename with timestamp
        const dateStr = now.toISOString().split('T')[0];
        const filename = `${department}_Checklist_${dateStr}.pdf`;
        
        // Download PDF
        doc.save(filename);
        
        console.log(`PDF exported successfully: ${filename}`);
    } catch (error) {
        console.error('Error generating PDF:', error);
        const errorMsg = error.message || 'Unknown error';
        if (errorMsg.includes('failed to load')) {
            showError('PDF library is still loading. Please wait a moment and try again.');
        } else {
            showError(`Failed to generate PDF: ${errorMsg}`);
        }
    }
}

// Function to show error message
function showError(message) {
    const errorMessage = document.getElementById("errorMessage");
    errorMessage.textContent = message;
    errorMessage.classList.add("active");
    setTimeout(() => {
        errorMessage.classList.remove("active");
    }, 5000);
}

// Function to hide error message
function hideError() {
    const errorMessage = document.getElementById("errorMessage");
    errorMessage.classList.remove("active");
}

addOnUISdk.ready.then(() => {
    console.log("addOnUISdk is ready for use.");

    // UI Elements
    const inputSection = document.getElementById("inputSection");
    const instructionsInput = document.getElementById("instructionsInput");
    const parseButton = document.getElementById("parseButton");
    const expandInstructionsButton = document.getElementById("expandInstructionsButton");
    const loadingIndicator = document.getElementById("loadingIndicator");
    const errorMessage = document.getElementById("errorMessage");
    const resultsSection = document.getElementById("resultsSection");
    const departmentGroups = document.getElementById("departmentGroups");
    const exportButton = document.getElementById("exportButton");
    const departmentSelect = document.getElementById("departmentSelect");

    // Enable parse button when textarea has content
    instructionsInput.addEventListener("input", () => {
        parseButton.disabled = !instructionsInput.value.trim();
    });

    // Parse button click handler
    parseButton.addEventListener("click", async () => {
        const instructions = instructionsInput.value.trim();
        
        if (!instructions) {
            showError("Please enter some design instructions to parse.");
            return;
        }

        // Hide previous errors and results
        hideError();
        resultsSection.classList.remove("active");
        
        // Show loading state
        loadingIndicator.classList.add("active");
        parseButton.disabled = true;

        try {
            // Call local API endpoint
            const parsedData = await parseInstructions(instructions);
            
            // Store the parsed data
            currentData = parsedData;
            
            // Render the department groups
            renderDepartmentGroups(parsedData);
            
            // Update export section (renderDepartmentGroups already calls updateExportSection, but ensure it's called)
            updateExportSection();
            
            // Show results section
            resultsSection.classList.add("active");
            
            // Collapse instruction input after successful parse
            collapseInstructionInput();
            
        } catch (error) {
            console.error("Error parsing instructions:", error);
            showError(error.message || "An error occurred while parsing instructions. Please try again.");
        } finally {
            // Hide loading state
            loadingIndicator.classList.remove("active");
            parseButton.disabled = !instructionsInput.value.trim();
        }
    });

    // Collapse instruction input
    function collapseInstructionInput() {
        inputSection.classList.add("collapsed");
        expandInstructionsButton.style.display = "block";
    }

    // Expand instruction input
    function expandInstructionInput() {
        inputSection.classList.remove("collapsed");
        expandInstructionsButton.style.display = "none";
        // Re-enable parse button if there's text
        parseButton.disabled = !instructionsInput.value.trim();
    }

    // Expand instructions button handler
    expandInstructionsButton.addEventListener("click", () => {
        expandInstructionInput();
        // Clear the textarea so user can enter fresh instructions
        instructionsInput.value = '';
        // Disable parse button since textarea is now empty
        parseButton.disabled = true;
        instructionsInput.focus();
    });

    // Enable the button when addOnUISdk is ready
    parseButton.disabled = !instructionsInput.value.trim();
    
    // Export button handler
    if (exportButton) {
        exportButton.addEventListener("click", () => {
            exportChecklistStatus();
        });
    }
    
    // Department select change handler
    if (departmentSelect) {
        departmentSelect.addEventListener("change", () => {
            updateExportButtonState();
        });
    }
});
